/**
 * Settlement signals.
 *
 * Every wait in this bridge used to be a poll: wake, re-read the job, ask
 * whether it is still running, sleep 250 ms, repeat. That put a uniform tax of
 * up to a quarter of a second on the end of every job, once per hop, and it
 * compounded across a workflow's waves and across a caller's own start-then-wait
 * pairs. The information those loops were polling for is already available as an
 * event: a job settles on its child's close, a cancellation is recorded when it
 * is requested, and a workflow settles in settle().
 *
 * So a caller registers here when it starts something and releases here when it
 * finishes, and every wait becomes a race between that signal and its own
 * deadline. The deadline cap is not a fallback for a missing signal, it is what
 * keeps a cancel or an expired parent deadline re-checked on time; the signal is
 * what makes the common case return the instant the work actually ends.
 */

/** key -> { promise, resolve } for work still running in this process. */
const signals = new Map();

/**
 * Subjects that have finished, kept briefly so a waiter that arrives after the
 * fact is told immediately instead of sitting out its cap.
 *
 * The bound keeps this a cache rather than a history.
 */
const finished = new Map();
const FINISHED_LIMIT = 256;

/** Sleep, holding the event loop for its duration. */
export function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * Start listening for one subject to finish.
 *
 * Returns the release function. Arming something already armed is a no-op and
 * returns the original release, so a double-arm cannot orphan a waiter. Arming
 * a subject that already finished discards the stale finished marker.
 */
export function arm(key) {
  finished.delete(key);
  const existing = signals.get(key);
  if (existing !== undefined) return existing.resolve;
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  signals.set(key, { promise, resolve });
  return () => {
    signals.delete(key);
    finished.set(key, promise);
    // Insertion order is the eviction order: drop the oldest marker.
    while (finished.size > FINISHED_LIMIT) {
      finished.delete(finished.keys().next().value);
    }
    resolve();
  };
}

/**
 * The signal for work still running here, or null.
 *
 * This deliberately does not fall back to a finished subject. A wait loop asks
 * this on every pass, and handing it an already-resolved promise would make the
 * race resolve instantly every time round — a loop that never yields to the
 * event loop, so the remaining children never close and the loop burns its
 * whole window waiting for an outcome it is no longer able to observe.
 */
function liveSignal(key) {
  return signals.get(key)?.promise ?? null;
}

/** True once this subject has been released, and while it is not re-armed. */
export function isFinished(key) {
  return finished.has(key) && !signals.has(key);
}

/**
 * A sleep that can be called off, so the losing side of a race does not keep the
 * event loop alive after the work is already done.
 *
 * The timer is deliberately not unref'd: a caller awaiting one of these helpers
 * is genuinely waiting, and an unref'd timer would let the process exit out from
 * under that await. Clearing it explicitly gives the same tidiness without that.
 */
function cappedSleep(ms) {
  let timer;
  const promise = new Promise((done) => {
    timer = setTimeout(done, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Wait until one subject settles, or the cap elapses.
 *
 * A subject already known to be finished returns at once. Otherwise this races
 * its live signal against the cap, which is also the fallback for a subject
 * nothing here tracks — a snapshot from an earlier process, or a test that
 * injects its own reader. Returning immediately in that case would turn a poll
 * into a hot loop.
 *
 * \`capMs\` stays bounded and small on purpose: it is the cadence at which a caller
 * still gets to notice a cancellation or a deadline that no settlement signal
 * will ever report.
 */
export function awaitSettlement(key, capMs) {
  if (isFinished(key)) return Promise.resolve();
  const pending = liveSignal(key);
  const cap = cappedSleep(capMs);
  if (pending === null) return cap.promise;
  return Promise.race([pending, cap.promise]).finally(() => cap.cancel());
}

/** Wait until any one of several subjects settles, or the cap elapses. */
export function awaitAnySettlement(keys, capMs) {
  const pending = keys.map((key) => liveSignal(key)).filter((promise) => promise !== null);
  const cap = cappedSleep(capMs);
  // Only an already-finished subject may end this immediately, and only once
  // nothing is left running. Returning on a finished subject while others are
  // still live is the bug this ordering exists to prevent.
  if (pending.length === 0) {
    return keys.some((key) => isFinished(key)) ? Promise.resolve() : cap.promise;
  }
  return Promise.race([...pending, cap.promise]).finally(() => cap.cancel());
}
