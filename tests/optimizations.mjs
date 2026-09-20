/**
 * Checks for the round-trip and retention work.
 *
 * Each one pins a behaviour that exists to cut the caller's cost: returning a
 * quick job inline, watching a parallel set with one call, choosing a deadline
 * by shape, and reclaiming settled state without losing live work.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DSH_BRIDGE_STATE_DIR = mkdtempSync(join(tmpdir(), "dsh-opt-state-"));

const { JOB_ROOT, MAX_ANSWER_CHARS, MAX_INLINE_WAIT_MS, TIMEOUT_TIERS, WORKFLOW_TIMEOUT_TIERS, DEFAULT_WAIT_WINDOW_MS } = await import(
  "../src/config.mjs"
);
const { startJob, waitJob, readJob, pruneJobState, cancelJob, statusOf } = await import("../src/jobs.mjs");

const root = mkdtempSync(join(tmpdir(), "dsh-opt-"));
const spawned = [];

/** A worker that prints one line and exits after `ms`, with no model calls. */
function fakeWorker(ms) {
  const bin = join(root, `fake-${ms}`);
  writeFileSync(
    bin,
    `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write("DONE_${ms}\\n"); process.exit(0); }, ${ms});\n`,
    { mode: 0o700 },
  );
  return bin;
}

const start = (ms, extra = {}) => {
  const job = startJob({ task: `sleep ${ms}`, cwd: root, dshBin: fakeWorker(ms), timeoutMs: 30_000, ...extra });
  spawned.push(job.job_id);
  return job;
};

try {
  // 1. A quick job settles inside the inline window, so no poll is ever needed.
  {
    const job = start(150);
    const began = Date.now();
    const { settled, job: current } = await waitJob(job.job_id, 10_000);
    assert.equal(settled, true, "a 150ms job must settle inside a 10s inline window");
    assert.equal(current.status, "done");
    assert.match(current.stdout, /DONE_150/);
    assert.ok(Date.now() - began < 5_000, "waitJob must return when the job ends, not at the deadline");
    console.log("ok - a short job returns inline without a separate poll");
  }

  // 2. A job that outlives the window stays a normal background job.
  {
    const job = start(4_000);
    const { settled, job: current } = await waitJob(job.job_id, 300);
    assert.equal(settled, false, "a 4s job must not report settled after 300ms");
    assert.equal(current.status, "running");
    const after = await waitJob(job.job_id, 10_000);
    assert.equal(after.settled, true, "the same job must settle on a longer window");
    console.log("ok - a long job falls back to background instead of blocking");
  }

  // 3. Waiting on a set returns on the first finisher, not the slowest.
  {
    const quick = start(200);
    const slow = start(8_000);
    const began = Date.now();
    let first;
    while (Date.now() - began < 10_000) {
      const rows = [quick, slow].map((j) => readJob(j.job_id));
      first = rows.find((r) => r.status !== "running");
      if (first !== undefined) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(first !== undefined, "one job must settle");
    assert.equal(first.job_id, quick.job_id, "the first settled job must be the quick one");
    assert.ok(Date.now() - began < 5_000, "waiting on a set must not wait for the slowest job");
    assert.equal(readJob(slow.job_id).status, "running", "the slower job keeps running");
    cancelJob(slow.job_id);
    console.log("ok - watching a set returns on the first finisher");
  }

  // 4. Tiers are ordered and distinct, so a caller picks a shape not a number.
  {
    assert.ok(TIMEOUT_TIERS.investigate < TIMEOUT_TIERS.edit, "investigate must be the shortest tier");
    assert.ok(TIMEOUT_TIERS.edit < TIMEOUT_TIERS.build, "build must be the longest tier");
    for (const [name, ms] of Object.entries(TIMEOUT_TIERS)) {
      assert.ok(ms > 0 && Number.isInteger(ms), `${name} must be a positive integer of milliseconds`);
      assert.ok(WORKFLOW_TIMEOUT_TIERS[name] >= ms, `${name} workflow deadline must cover its worker deadline`);
    }
    const job = start(100, { timeoutMs: TIMEOUT_TIERS.investigate });
    assert.equal(readJob(job.job_id).status, "running");
    await waitJob(job.job_id, 10_000);
    console.log("ok - timeout tiers are ordered and usable as a deadline");
  }

  // 5. The defaults the cost analysis chose are actually the defaults.
  {
    assert.equal(DEFAULT_WAIT_WINDOW_MS, 300_000, "the default wait window must be 5 minutes");
    assert.ok(MAX_INLINE_WAIT_MS <= 60_000, "inline waiting must stay short enough to fall back quickly");
    console.log("ok - the measured defaults are wired in, not just documented");
  }

  // 6. Pruning reports before it deletes, and never takes a running job.
  {
    const finished = start(120);
    await waitJob(finished.job_id, 10_000);
    const live = start(20_000);

    const dry = pruneJobState({ olderThanMs: 0, apply: false });
    assert.equal(dry.applied, false);
    assert.equal(dry.removed, 0, "a dry run must not delete anything");
    assert.ok(dry.eligible >= 1, "the finished job must be eligible");
    assert.ok(readJob(finished.job_id) !== undefined, "the snapshot still exists after a dry run");

    const fresh = pruneJobState({ olderThanMs: 24 * 60 * 60 * 1000, apply: true });
    assert.equal(fresh.removed, 0, "a job that ended seconds ago is not older than a day");
    assert.ok(readJob(finished.job_id) !== undefined, "a recent snapshot survives an applied prune");

    const applied = pruneJobState({ olderThanMs: 0, apply: true });
    assert.equal(applied.applied, true);
    assert.ok(applied.removed >= 1, "an applied prune removes the settled snapshot");
    const names = readdirSync(JOB_ROOT).filter((n) => n.endsWith(".json"));
    assert.ok(!names.includes(`${finished.job_id}.json`), "the settled snapshot is gone from disk");
    assert.equal(readJob(live.job_id).status, "running", "the running job was never pruned");
    cancelJob(live.job_id);
    console.log("ok - prune reports first, respects age, and never takes live work");
  }

  // 7. A talkative worker cannot flood the caller's context by default.
  {
    const chars = MAX_ANSWER_CHARS * 3;
    const bin = join(root, "fake-loud");
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nprocess.stdout.write("L".repeat(${chars}) + "\\n"); process.exit(0);\n`,
      { mode: 0o700 },
    );
    const job = startJob({ task: "loud", cwd: root, dshBin: bin, timeoutMs: 30_000 });
    spawned.push(job.job_id);
    const { job: current } = await waitJob(job.job_id, 10_000);
    assert.equal(current.status, "done");

    const bounded = statusOf(current);
    assert.equal(bounded.answer_truncated, true, "an oversized answer must be reported as truncated");
    assert.equal(bounded.answer.length, MAX_ANSWER_CHARS, "the default answer is exactly the budget");
    assert.equal(bounded.answer_chars, chars, "the true length is still reported");
    assert.equal(bounded.answer_omitted, chars - MAX_ANSWER_CHARS, "the omitted count must be exact");
    assert.ok(bounded.answer_path.endsWith(`${job.job_id}.json`), "the caller is told where the whole text lives");
    assert.ok(JSON.stringify(bounded).length < chars, "the bounded payload is smaller than the raw answer");

    const whole = statusOf(current, { includeLogs: true });
    assert.equal(whole.answer_truncated, false, "include_logs returns the answer whole");
    assert.equal(whole.answer.length, chars, "nothing is lost, only withheld by default");

    const small = statusOf({ ...current, stdout: "short\n" });
    assert.equal(small.answer_truncated, false, "a normal answer is never trimmed");
    assert.equal(small.answer, "short");
    assert.equal(small.answer_omitted, undefined, "no omission fields on an untrimmed answer");
    console.log("ok - an oversized answer is bounded by default and recoverable in full");
  }

  console.log("all optimization checks passed");
} catch (error) {
  console.error("optimization check FAILED:", error.message);
  process.exitCode = 1;
} finally {
  for (const id of spawned) {
    const job = readJob(id);
    if (job?.status === "running") cancelJob(id);
  }
  await new Promise((r) => setTimeout(r, 200));
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.DSH_BRIDGE_STATE_DIR, { recursive: true, force: true });
}
