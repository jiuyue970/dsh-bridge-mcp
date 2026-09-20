#!/usr/bin/env node
// Regression check for job cancellation: node tests/cancel.mjs
// Offline: the worker is this Node binary, reached through an exec'ing /bin/sh
// wrapper. It prints READY once it is really the Node process (not the shell),
// installs no signal handlers of its own, and exits by itself after 6s.
//
// That exit delay is the point: a cancellation confirmed within 1s, well before
// the natural exit, can only be the SIGTERM landing. A test that merely waits
// past the natural exit would pass even if no signal were ever sent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelJob, readJob, startJob } from "../src/jobs.mjs";

const NATURAL_EXIT_MS = 6_000;
const CANCEL_EXIT_MS = 1_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
};

async function until(predicate, label, timeoutMs = 8_000) {
  for (let waited = 0; waited < timeoutMs; waited += 25) {
    if (predicate()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const tmpCwd = mkdtempSync(join(tmpdir(), "dsh-cancel-"));
const fakeBin = join(tmpCwd, "fake-dsh");
// exec replaces the shell with Node, so a SIGTERM reaches the worker itself and
// the default disposition ends it. READY is printed by Node, after the exec:
// seeing it proves the signalled pid is Node, not /bin/sh.
writeFileSync(
  fakeBin,
  `#!/bin/sh\nexec "${process.execPath}" -e 'process.stdout.write("READY\\n");` +
    ` setTimeout(() => process.exit(0), ${NATURAL_EXIT_MS});'\n`,
  { mode: 0o755 },
);

const started = [];
function worker(task) {
  const job = startJob({ task, cwd: tmpCwd, timeoutMs: 60_000, dshBin: fakeBin });
  started.push(job);
  assert.equal(job.status, "running");
  return job;
}

/**
 * Cancel, then require the real pid to die from the signal, not from its own
 * 6s timer: exit must land inside 1s and the exit must be signal-driven.
 */
async function cancelAndConfirmExit(job) {
  const startedAt = Date.now();
  const result = cancelJob(job.job_id);
  assert.equal(result.cancelled, true, `expected a real cancellation: ${JSON.stringify(result)}`);
  await until(() => !alive(job.pid), `pid ${job.pid} to exit after SIGTERM`, CANCEL_EXIT_MS);
  const waited = Date.now() - startedAt;
  assert.ok(
    waited < NATURAL_EXIT_MS,
    `pid ${job.pid} must exit from SIGTERM, not its ${NATURAL_EXIT_MS}ms timer (waited ${waited}ms)`,
  );
  assert.equal(
    job.proc.signalCode,
    "SIGTERM",
    `pid ${job.pid} must have ended by SIGTERM, saw signalCode=${job.proc.signalCode}`,
  );
  return result;
}

try {
  // 1) Cancellation must actually end the started worker's process.
  const first = worker("cancel-path");
  await until(() => first.stdout.includes("READY"), "worker readiness banner");
  assert.equal(alive(first.pid), true, "worker must be live before cancel");
  await cancelAndConfirmExit(first);
  assert.equal(readJob(first.job_id).status, "cancelled");
  console.log(`ok - cancel stopped pid ${first.pid}`);

  // 2) A false kill() must not settle the job or claim cancellation.
  // The restored handle stays reachable from the job, so a failure before the
  // restore still leaves cleanup able to kill it.
  const stuck = worker("kill-returns-false");
  await until(() => stuck.stdout.includes("READY"), "worker readiness banner");
  const realKill = stuck.proc.kill;
  stuck.proc.kill = () => false;
  try {
    const refused = cancelJob(stuck.job_id);
    assert.equal(refused.cancelled, false, "a false kill() must not report cancelled");
    assert.equal(stuck.status, "running", "a false kill() must not change job status");
  } finally {
    stuck.proc.kill = realKill;
  }
  await cancelAndConfirmExit(stuck);
  assert.equal(readJob(stuck.job_id).status, "cancelled");
  console.log("ok - false kill() neither cancels nor settles the job");

  // 3) Repeated and unknown cancels never over-report.
  const once = worker("already-cancelled");
  await until(() => once.stdout.includes("READY"), "worker readiness banner");
  await cancelAndConfirmExit(once);
  assert.equal(cancelJob(once.job_id).cancelled, false, "a second cancel must not claim success");
  assert.equal(cancelJob("no-such-job").cancelled, false, "an unknown job must not claim success");
  console.log("ok - repeated and unknown cancels stay honest");

  // 4) Ordinary completion is untouched: exit 0 still means done.
  const fine = worker("completion-path");
  await until(() => readJob(fine.job_id).status === "done", "worker to finish on its own");
  assert.equal(readJob(fine.job_id).exit_code, 0);
  assert.equal(cancelJob(fine.job_id).cancelled, false, "a finished job is not cancellable");
  console.log("ok - a worker that exits 0 is still done");

  console.log("all cancel checks passed");
} finally {
  // Only our own still-running handles get a blind SIGKILL; wait for each one to
  // actually go away before the temp dir (holding the worker script) is removed.
  const stragglers = started.filter(
    (job) =>
      job.proc !== undefined && job.proc.exitCode === null && job.proc.signalCode === null,
  );
  for (const job of stragglers) {
    try {
      job.proc.kill("SIGKILL");
    } catch {
      // It may have exited between the check and the kill.
    }
  }
  for (const job of stragglers) {
    await until(
      () => job.proc.exitCode !== null || job.proc.signalCode !== null || !alive(job.pid),
      `pid ${job.pid} to exit after SIGKILL`,
      5_000,
    );
  }
  for (const job of started) {
    if (job.proc === undefined && job.pid !== undefined) {
      // Older handle-less implementation: nothing to signal, so let the worker
      // reach its own 6s exit before the fixture is deleted under it.
      await until(() => !alive(job.pid), `pid ${job.pid} to finish on its own`, NATURAL_EXIT_MS + 2_000);
    }
  }
  rmSync(tmpCwd, { recursive: true, force: true });
}
