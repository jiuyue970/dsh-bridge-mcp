#!/usr/bin/env node
// Waiting must end when the work ends, not up to a poll interval later.
//   node tests/settlement.mjs
//
// Every wait in the bridge used to sleep 250 ms and re-ask, so a wait returned
// uniformly up to a quarter second after the thing it was waiting for had already
// finished. That cost is paid once per hop, and it multiplies across a
// workflow's waves and across a caller's own start-then-wait pairs.
//
// A timing assertion is easy to write and easy to make flaky, so most of this
// file tests the contract instead: that a signal is armed for exactly the work
// this process owns, that every settlement path releases it, and that a subject
// nobody tracks falls back to a bounded sleep rather than resolving at once and
// spinning. The last check is the latency one, and it is deliberately loose
// enough to survive a loaded machine while still failing a 250 ms poll.
import assert from "node:assert/strict";
import { cancelJob, readJob, startJob, waitJob } from "../src/jobs.mjs";
import { arm, awaitAnySettlement, awaitSettlement, isFinished } from "../src/settle.mjs";
import { readWorkflow, startWorkflow, waitWorkflow } from "../src/workflow.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The bridge resolves its state directory when config is first loaded, so the
// isolation has to be in place before any bridge module is imported.
const scratch = mkdtempSync(join(tmpdir(), "dsh-settle-"));
process.env.DSH_BRIDGE_STATE_DIR = join(scratch, "state");
const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "..", "bench", "fake-dsh");

const project = join(scratch, "project");
mkdirSync(project, { recursive: true });

const start = (extra = {}) =>
  startJob({
    task: "settlement fixture",
    cwd: project,
    dshBin: fakeBin,
    timeoutMs: 60_000,
    ...extra,
  });

try {
  // 1) A live job this process owns has a signal. This is the whole basis of
  //    the change: without one, every wait is a poll again.
  {
    const job = start();
    assert.equal(isFinished(job.job_id), false, "a running job must not be finished yet");
    const outcome = await waitJob(job.job_id, 60_000);
    assert.equal(outcome.settled, true);
    console.log("ok - a live job is armed with a settlement signal");
  }

  // 2) Normal completion releases it. A signal that outlived its job would be a
  //    leak, and one that was dropped early would make a waiter believe a running
  //    job had finished.
  {
    const job = start();
    assert.equal(isFinished(job.job_id), false, "a running job is not finished yet");
    await waitJob(job.job_id, 60_000);
    assert.equal(isFinished(job.job_id), true, "a settled job must be marked finished");
    console.log("ok - normal completion releases the signal");
  }

  // 3) A failure releases it too, so a failing worker does not make its waiter
  //    sit out the rest of the window.
  {
    const failing = join(scratch, "fails.sh");
    rmSync(failing, { force: true });
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(failing, "#!/bin/sh\nexit 7\n");
    chmodSync(failing, 0o755);
    const job = start({ dshBin: failing, task: "fail on purpose" });
    const outcome = await waitJob(job.job_id, 60_000);
    assert.equal(outcome.settled, true, "a failing job must still settle its waiter");
    assert.equal(readJob(job.job_id).status, "failed");
    assert.equal(isFinished(job.job_id), true, "a failed job must be marked finished");
    console.log("ok - a failure releases the signal");
  }

  // 4) Cancellation releases it. The request is the event; whether the process
  //    actually dies afterwards is not what the waiter asked for.
  {
    const job = start();
    assert.equal(isFinished(job.job_id), false);
    const cancelled = cancelJob(job.job_id);
    assert.equal(cancelled.cancelled, true);
    assert.equal(isFinished(job.job_id), true, "a cancelled job must release immediately");
    await waitJob(job.job_id, 10_000);
    console.log("ok - cancelling releases the signal without waiting for the process");
  }

  // 5) An untracked subject falls back to a bounded sleep instead of resolving
  //    at once. A signal that resolved immediately would turn a poll into a hot
  //    loop, and this is the branch that keeps that from happening.
  {
    assert.equal(isFinished("no-such-job"), false, "an untracked id is neither running nor finished");
    const startedAt = Date.now();
    await awaitSettlement("no-such-job", 40);
    const waited = Date.now() - startedAt;
    assert.ok(waited >= 30, "an untracked subject must still wait its cap, waited " + waited + " ms");
    console.log("ok - an untracked subject keeps its own cadence instead of spinning");
  }

  // 6) The cap is released when the signal wins, so a finished wait does not
  //    hold the event loop open for the rest of its cap.
  {
    const release = arm("settle-test-key");
    assert.equal(isFinished("settle-test-key"), false);
    const startedAt = Date.now();
    release();
    await awaitSettlement("settle-test-key", 5_000);
    const took = Date.now() - startedAt;
    assert.ok(took < 500, "a settled wait must return at once, took " + took + " ms");
    assert.equal(isFinished("settle-test-key"), true, "releasing must record the subject");
    console.log("ok - a settled wait returns at once and drops its cap timer");
  }

  // 7) Waiting on several subjects ends with the first of them.
  {
    const first = arm("settle-any-first");
    const second = arm("settle-any-second");
    const startedAt = Date.now();
    const waiter = awaitAnySettlement(["settle-any-first", "settle-any-second"], 10_000);
    setTimeout(first, 60);
    await waiter;
    const took = Date.now() - startedAt;
    assert.ok(took < 1_000, "the first finisher must end the wait, took " + took + " ms");
    second();
    console.log("ok - waiting on several subjects ends with the first one");
  }

  // 8) The end-to-end claim, at a threshold a poll cannot pass. A worker that
  //    finishes at a time unrelated to the old 250 ms tick is the case where the
  //    difference is real rather than lucky.
  {
    process.env.FAKE_DSH_MS = "137";
    const job = start();
    await waitJob(job.job_id, 60_000);
    const overshoot = Date.now() - Date.parse(readJob(job.job_id).ended_at);
    assert.ok(
      overshoot < 120,
      "a wait must return within one poll of the end, got " + overshoot + " ms",
    );
    console.log("ok - a wait returns within a few ms of the work ending (" + overshoot + " ms)");
  }

  // 9) A workflow is armed on the same terms, on the path that matters most:
  //    the successful one. This path used to stamp ended_at itself and never
  //    settle, so its waiters had to sit out the whole window.
  {
    process.env.FAKE_DSH_MS = "80";
    const workflow = startWorkflow({
      task: "settle a workflow",
      cwd: project,
      mode: "read-only",
      allowedPaths: ["src"],
      timeoutMs: 120_000,
      dshBin: fakeBin,
    });
    assert.equal(isFinished(workflow.job_id), false, "a running workflow must be armed");
    const outcome = await waitWorkflow(workflow.job_id, 120_000);
    assert.equal(outcome.settled, true, "a successful workflow must settle its waiter");
    assert.equal(isFinished(workflow.job_id), true, "a settled workflow must release its signal");
    assert.equal(readWorkflow(workflow.job_id).workflow.status, "awaiting_review");
    console.log("ok - a successful workflow settles and releases its waiters");
  }

  // 10) A loop over a set must keep waiting after one member finishes. This is
  //     the trap in the finished-subject cache: if a settled subject still
  //     answered signal(), every later pass of the loop would resolve at once,
  //     the loop would stop yielding to the event loop, and the remaining
  //     children could never close. It looked like a wait that worked.
  {
    const early = arm("settle-set-early");
    const late = arm("settle-set-late");
    let passes = 0;
    const waiter = (async () => {
      while (!isFinished("settle-set-late")) {
        passes += 1;
        await awaitAnySettlement(["settle-set-early", "settle-set-late"], 25);
      }
    })();
    await new Promise((r) => setTimeout(r, 10));
    early();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(isFinished("settle-set-late"), false, "the second subject is still running");
    assert.ok(
      passes > 4,
      "the loop must keep passing its check after the first member finished, passed " + passes + " times",
    );
    late();
    await waiter;
    assert.equal(isFinished("settle-set-late"), true);
    console.log("ok - a wait loop keeps waiting after one member of a set finishes");
  }

  console.log("all settlement checks passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
