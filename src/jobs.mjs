import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { invalidate, listRows } from "./jobindex.mjs";
import { arm, awaitSettlement } from "./settle.mjs";
import {
  CREDENTIAL_ENV_ALLOWLIST,
  CREDENTIAL_ENV_PATTERN,
  DEFAULT_DSH_BIN,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  DIAGNOSTIC_CHARS,
  isSystemJobId,
  JOB_ROOT,
  MAX_ANSWER_CHARS,
  MAX_DIAGNOSTICS,
  MAX_OUTPUT_CHARS,
  MAX_STDERR_CHARS,
} from "./config.mjs";

/** In-memory registry of live jobs. Persisted separately for cross-call reads. */
const jobs = new Map();

/**
 * Build the child environment.
 *
 * The parent environment is copied minus credential-shaped names, except for
 * an explicit allowlist of names the child genuinely needs (DSH_HOME, PATH...).
 */
function childEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (CREDENTIAL_ENV_ALLOWLIST.has(key)) {
      env[key] = value;
      continue;
    }
    if (CREDENTIAL_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function ensureJobRoot() {
  mkdirSync(JOB_ROOT, { recursive: true });
}

/** Create the job root without blocking. Used by the paths that already await. */
async function ensureJobRootAsync() {
  try {
    await mkdir(JOB_ROOT, { recursive: true });
  } catch {
    // A listing over a missing root simply has nothing to list.
  }
}

/**
 * The fields a job snapshot contributes to a listing and to a prune.
 *
 * Deliberately not the whole snapshot: stdout and stderr are the bulk of these
 * files and neither path needs them. The index keeps only these, so caching a
 * few thousand jobs costs a few hundred kilobytes instead of 59 MB.
 */
const JOB_ROW_FIELDS = ["job_id", "status", "task", "cwd", "created_at", "ended_at"];

/**
 * Minimum gap between snapshot writes while a job is still running.
 *
 * stdout arrives in as many chunks as the child happens to write, and a chunk
 * used to rewrite the whole snapshot synchronously. A worker streaming an 80 KB
 * answer in 40 chunks therefore wrote ~1.6 MB -- 21x the answer -- and blocked
 * the event loop on every one of them, which is the same class of problem the
 * read-side index exists to fix.
 *
 * The rate is bounded rather than deduplicated so the cost stops depending on
 * how a particular worker happens to chunk its output, which is not something
 * the bridge controls or can predict. Settling always flushes, so a finished
 * job is still written in full and nothing is lost: the snapshot of a running
 * job is a progress record, and its answer is only complete at close anyway.
 */
const PERSIST_INTERVAL_MS = 250;

/** Persist a compact job snapshot. Never throws: persistence is best-effort. */
function persist(job) {
  try {
    ensureJobRoot();
    const snapshot = {
      job_id: job.job_id,
      status: job.status,
      task: job.task,
      cwd: job.cwd,
      created_at: job.created_at,
      ended_at: job.ended_at,
      exit_code: job.exit_code,
      exit_signal: job.exit_signal ?? null,
      error: job.error,
      stdout: job.stdout,
      stderr: job.stderr,
      truncated: job.truncated,
    };
    const name = `${job.job_id}.json`;
    writeFileSync(join(JOB_ROOT, name), JSON.stringify(snapshot));
    // This process just rewrote the file, so any row a listing cached for it is
    // stale even if the filesystem's mtime resolution cannot see the change.
    invalidate(JOB_ROOT, name);
  } catch {
    // A read-only or full temp dir must not fail the delegation itself.
  }
}

/**
 * Persist soon, at most once per {@link PERSIST_INTERVAL_MS}.
 *
 * Used on the chunk path, where the number of calls is decided by the worker
 * rather than by the bridge. A write already pending is left to stand: the
 * later chunks it will capture are strictly fresher than this one.
 */
function schedulePersist(job) {
  if (job.persist_timer !== undefined) return;
  const timer = setTimeout(() => {
    job.persist_timer = undefined;
    persist(job);
  }, PERSIST_INTERVAL_MS);
  timer.unref?.();
  job.persist_timer = timer;
}

/**
 * Persist now, cancelling any write still pending.
 *
 * Every settling path goes through here rather than through `persist` so that
 * the final state reaches disk immediately and cannot be overtaken by a timer
 * that was scheduled before it.
 */
function flushPersist(job) {
  if (job.persist_timer !== undefined) {
    clearTimeout(job.persist_timer);
    job.persist_timer = undefined;
  }
  persist(job);
}

/**
 * Look a job up in memory, falling back to its persisted snapshot.
 *
 * The id is shape-checked before it is joined into a path. A persisted lookup
 * builds `${jobId}.json` under JOB_ROOT, so an unchecked id containing `/` or
 * `..` would read a file outside the job root. Every id this bridge mints is a
 * `randomUUID()`, so the guard cannot hide a real job; an id that is not one of
 * ours is simply unknown.
 */
export function readJob(jobId) {
  if (!isSystemJobId(jobId)) return undefined;
  const live = jobs.get(jobId);
  if (live !== undefined) return live;
  try {
    const raw = readFileSync(join(JOB_ROOT, `${jobId}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * In-memory job record only, or undefined once this process no longer holds it.
 *
 * The parent workflow controller uses this to distinguish "I own this live
 * worker process" from "a snapshot of it exists on disk from another run".
 */
export function readJobLive(jobId) {
  return jobs.get(jobId);
}

/**
 * Every job this bridge knows about, newest first, as a list row.
 *
 * Rows carry only what a listing shows and what a prune needs, and they are read
 * through the shared index, so an unchanged snapshot costs one stat instead of a
 * read and a parse. A live job this process owns overrides the row on disk,
 * which is the same precedence the previous full-snapshot merge had.
 */
export async function listJobs() {
  await ensureJobRootAsync();
  const seen = new Map();
  for (const { row } of await listRows(JOB_ROOT, JOB_ROW_FIELDS)) {
    seen.set(row.job_id, row);
  }
  for (const [id, job] of jobs) {
    seen.set(id, {
      job_id: id,
      status: job.status,
      task: job.task,
      cwd: job.cwd,
      created_at: job.created_at,
      ended_at: job.ended_at,
    });
  }
  return [...seen.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/**
 * Block until one plain worker job settles, or the window closes.
 *
 * Both `dsh_wait` and the inline wait inside `dsh_start` need this, and a
 * second copy would be a second place for the polling interval and the
 * settled-check to drift apart.
 */
export async function waitJob(jobId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  let current = readJob(jobId);
  if (current === undefined) return { settled: false, job: undefined };
  while (current.status === "running" && Date.now() < deadline) {
    // Wake on the child's close, so a caller pays the real remaining time rather
    // than up to a quarter of a second more. The cap is kept because this loop
    // also has to re-check a job that is live but not tracked here, and because
    // the deadline still has to be noticed.
    await awaitSettlement(jobId, Math.min(250, Math.max(25, deadline - Date.now())));
    current = readJob(jobId) ?? current;
  }
  return { settled: current.status !== "running", job: current };
}

/**
 * Remove this bridge's own finished job snapshots older than a cutoff.
 *
 * Only settled jobs are eligible: a running job's snapshot is the sole record
 * a later process has of it. The caller decides whether to apply the deletion,
 * because losing evidence is worse than keeping bytes.
 */
export async function pruneJobState({ olderThanMs, apply = false, now = Date.now() } = {}) {
  const cutoff = now - olderThanMs;
  const removable = [];
  let kept = 0;
  let bytes = 0;
  await ensureJobRootAsync();
  // Same index a listing uses: a prune reads every snapshot, so it was paying
  // the identical 59 MB on every dry run.
  for (const entry of await listRows(JOB_ROOT, JOB_ROW_FIELDS)) {
    const snap = entry.row;
    const ended = snap.ended_at === null || snap.ended_at === undefined ? null : Date.parse(snap.ended_at);
    const settled = snap.status !== "running" && ended !== null && !Number.isNaN(ended);
    if (!settled || ended > cutoff || jobs.get(snap.job_id)?.status === "running") {
      kept += 1;
      continue;
    }
    removable.push({ job_id: snap.job_id, ended_at: snap.ended_at, bytes: entry.size });
    bytes += entry.size;
  }
  let removed = 0;
  if (apply) {
    for (const entry of removable) {
      const name = `${entry.job_id}.json`;
      try {
        rmSync(join(JOB_ROOT, name));
        // A row for a file this process just deleted must never be served again.
        invalidate(JOB_ROOT, name);
        removed += 1;
      } catch {
        // Leave a file we cannot delete; the report still names it.
      }
    }
  }
  return { eligible: removable.length, bytes, kept, removed, applied: apply === true };
}

function appendBounded(job, channel, chunk) {
  const text = chunk.toString("utf8");
  if (channel === "stdout") {
    if (job.stdout.length >= MAX_OUTPUT_CHARS) {
      job.truncated = true;
      return;
    }
    const room = MAX_OUTPUT_CHARS - job.stdout.length;
    job.stdout += text.slice(0, room);
    if (text.length > room) job.truncated = true;
  } else {
    // The end of stderr, not the start: a failing worker's last line is the
    // diagnostic that explains the failure, and it comes after the reasoning.
    job.stderr = (job.stderr + text).slice(-MAX_STDERR_CHARS);
  }
}

/**
 * Start one delegated DSH task.
 *
 * Returns immediately with a job id; the worker runs in the background so the
 * calling agent is never blocked for the length of a long task.
 */
export function startJob({ task, cwd, timeoutMs, dshBin, profile, deadlineAt }) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("task must be a non-empty string");
  }
  const resolvedCwd = cwd ?? process.cwd();
  try {
    if (!statSync(resolvedCwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new Error(`cwd is not a usable directory: ${resolvedCwd} (${error.message})`);
  }

  // A parent workflow passes an absolute wall-clock deadline so every worker it
  // starts shares one budget; a negative remaining budget means the deadline
  // already passed, which must never start a process.
  if (deadlineAt !== undefined) {
    if (Date.now() >= deadlineAt) {
      throw new Error("deadline has already passed; refusing to start a worker");
    }
  }

  const jobId = randomUUID();
  const bin = dshBin ?? process.env.DSH_BIN ?? DEFAULT_DSH_BIN;
  const args = ["--profile", profile ?? DEFAULT_PROFILE, task];

  const job = {
    job_id: jobId,
    status: "running",
    task,
    cwd: resolvedCwd,
    created_at: new Date().toISOString(),
    ended_at: null,
    exit_code: null,
    error: null,
    stdout: "",
    stderr: "",
    truncated: false,
    bin,
    args,
  };
  jobs.set(jobId, job);
  persist(job);

  // Waiters stop polling the moment this job settles, rather than up to a
  // polling interval later. The release is kept on the job so cancelJob can
  // release it too: a cancelled job is settled the moment the request lands.
  const settled = arm(jobId);
  job.releaseWaiters = settled;

  let proc;
  try {
    proc = spawn(bin, args, { cwd: resolvedCwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    job.status = "failed";
    job.error = `spawn failed: ${error.message}`;
    job.ended_at = new Date().toISOString();
    flushPersist(job);
    settled();
    return job;
  }
  job.pid = proc.pid;
  // Keep the live handle so cancelJob can signal this process later. Holding the
  // ChildProcess (not just the pid) is what makes cancellation exact.
  job.proc = proc;

  // A parent workflow may pass an absolute deadline. The worker must never
  // outlive it, so the effective limit is whichever comes first.
  let limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  if (deadlineAt !== undefined) {
    limit = Math.min(limit, Math.max(1, deadlineAt - Date.now()));
  }
  const timer = setTimeout(() => {
    if (job.status !== "running") return;
    job.status = "timed-out";
    job.error = `exceeded timeout of ${limit}ms`;
    try {
      proc.kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }, limit);
  timer.unref?.();
  job.timer = timer;

  proc.stdout.on("data", (chunk) => {
    appendBounded(job, "stdout", chunk);
    // Not `persist`: the child decides how many chunks stdout arrives in, and
    // rewriting the whole snapshot per chunk made that cost grow with the
    // square of the answer.
    schedulePersist(job);
  });
  proc.stderr.on("data", (chunk) => {
    appendBounded(job, "stderr", chunk);
  });

  proc.on("error", (error) => {
    clearTimeout(timer);
    job.status = "failed";
    job.error = `process error: ${error.message}`;
    job.ended_at = new Date().toISOString();
    flushPersist(job);
    settled();
  });

  /**
   * Settle the job after both stdio streams have ended.
   *
   * Node's `exit` fires when the process is reaped, but it carries no guarantee
   * that stdout has been fully delivered: `exit` and `close` are measurably
   * different events when a child leaves another process holding the pipe
   * (observed locally: exit at 49ms, close at 3008ms). Settlement therefore
   * happens on `close`, which is defined as "the stdio streams have ended" —
   * the exact condition under which the recorded answer is complete.
   *
   * `exit` still records the exit code and signal immediately, so a caller
   * inspecting `job.exit_code` while streams drain sees the true value.
   */
  proc.on("exit", (code, signal) => {
    job.exit_code = code;
    job.exit_signal = signal;
  });

  proc.on("close", (code, signal) => {
    clearTimeout(timer);
    job.exit_code = code;
    job.ended_at = new Date().toISOString();
    if (job.status === "cancelled") {
      // Cancellation already settled this job.
    } else if (job.status === "timed-out") {
      // Timeout already settled this job; keep the recorded reason.
    } else if (signal !== null && signal !== undefined) {
      job.status = "failed";
      job.error = `terminated by signal ${signal}`;
    } else if (code === 0) {
      job.status = "done";
    } else {
      job.status = "failed";
      job.error =
        job.stderr.trim() !== ""
          ? `exited with code ${code}`
          : `exited with code ${code} and no diagnostic on stderr`;
    }
    flushPersist(job);
    jobs.set(jobId, job);
    settled();
  });

  return job;
}

/**
 * Request cancellation.
 *
 * Requests SIGTERM for the direct child process and reports what actually
 * happened. The job is only marked "cancelled" once kill() really delivered
 * the signal; a missing handle, an exited process, or a kill() that returns
 * false is reported as not cancelled rather than mislabelled.
 *
 * Requesting a signal is not confirmation that the process tree has exited:
 * only the direct child is signalled, so grandchildren may outlive it.
 */
export function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (job === undefined) return { cancelled: false, reason: "unknown or expired job" };
  if (job.status !== "running") {
    return { cancelled: false, reason: `job is already ${job.status}` };
  }
  const proc = job.proc;
  if (proc === undefined || proc === null || typeof proc.kill !== "function") {
    // Nothing to signal. Do not claim a cancellation that never happened.
    return { cancelled: false, reason: "no process handle for this job; nothing was signalled" };
  }
  if (proc.exitCode !== null || proc.signalCode !== null) {
    // Already gone: let the exit handler settle the job.
    return { cancelled: false, reason: "process has already exited" };
  }
  let signalled;
  try {
    signalled = proc.kill("SIGTERM");
  } catch (error) {
    return { cancelled: false, reason: `kill failed: ${error.message}` };
  }
  if (signalled !== true) {
    // kill() reports false when nothing was signalled (already reaped or
    // undeliverable). Leave the job running and let the exit handler settle it.
    return { cancelled: false, reason: "kill() reported no signal was delivered" };
  }
  job.status = "cancelled";
  job.error = "cancelled by request";
  job.ended_at = new Date().toISOString();
  flushPersist(job);
  // The cancellation is recorded, so anyone waiting on this job has their answer
  // now; whether the process actually dies is not what they asked for.
  job.releaseWaiters?.();
  return { cancelled: true, pid: job.pid ?? null, signal: "SIGTERM" };
}

/**
 * Diagnostic lines from a worker's stderr, without its reasoning.
 *
 * DSH headless streams the worker's reasoning to stderr as `dsh: reasoning:`
 * blocks and reports a failed provider call as one `dsh: CODE: message` line.
 * Over 1,310 job snapshots there were 7,551 reasoning blocks, and every other
 * `dsh:` line was a PI_AI_ERROR or RATE_LIMIT report. The reasoning is the
 * worker's own thinking and of no use to the caller; a diagnostic is the reason
 * a job failed, which `error` alone ("exited with code 1") does not say.
 * `reason` rather than `reasoning:` also rejects a block header cut short where
 * the kept stream begins.
 */
export function extractDiagnostics(stderr) {
  const lines = [];
  for (const match of String(stderr ?? "").matchAll(/^dsh: (?!reason)(.+)$/gm)) {
    const line = match[1].trim().slice(0, DIAGNOSTIC_CHARS);
    if (line !== "" && !lines.includes(line)) lines.push(line);
  }
  return lines.slice(-MAX_DIAGNOSTICS);
}

/**
 * Short factual status.
 *
 * Every field here is re-sent with each later request of the caller's
 * conversation, so a field earns its place by telling the caller something:
 * the working directory it chose itself is not repeated, and flags that are
 * almost always false (`truncated`, `answer_truncated`) appear only when true.
 * The worker's reasoning is never included; `dsh_tail` reads it.
 *
 * `answerLimit` lets a caller that is returning several jobs at once share one
 * budget between them; on its own a job gets the full `MAX_ANSWER_CHARS`.
 * `includeLogs` returns the answer whole.
 */
export function statusOf(job, { includeLogs = false, answerLimit = MAX_ANSWER_CHARS } = {}) {
  const out = {
    job_id: job.job_id,
    kind: "job",
    status: job.status,
    created_at: job.created_at,
    ended_at: job.ended_at,
    exit_code: job.exit_code,
  };
  if (job.error) out.error = job.error;
  const diagnostics = extractDiagnostics(job.stderr);
  if (diagnostics.length > 0) out.diagnostics = diagnostics;
  // Output capture hit MAX_OUTPUT_CHARS: rare, so only reported when it happened.
  if (job.truncated === true) out.truncated = true;

  const limit = Math.max(0, Math.min(answerLimit, MAX_ANSWER_CHARS));
  const answer = extractAnswer(job.stdout);
  out.answer_chars = answer.length;
  if (includeLogs || answer.length <= limit) {
    out.answer = answer;
  } else {
    out.answer = answer.slice(0, limit);
    out.answer_truncated = true;
    out.answer_omitted = answer.length - limit;
    out.answer_path = join(JOB_ROOT, `${job.job_id}.json`);
    out.answer_note =
      "Answer trimmed for the caller's context. Re-read with include_logs=true, " +
      "or read the stdout field of answer_path for the whole text.";
  }
  return out;
}

/**
 * The worker writes its final assistant message to stdout.
 *
 * DSH headless prints only that message, so stdout is the answer. It may be
 * wrapped in a markdown fence when the model chose to format it that way; that
 * fence is stripped so the caller receives plain text.
 */
export function extractAnswer(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") return "";
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
}
