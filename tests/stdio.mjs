#!/usr/bin/env node
// Checks for job settlement and final-answer capture: node tests/stdio.mjs
//
// Node's `exit` event fires when the child is reaped, but it does not guarantee
// that stdout has been fully delivered. `close` does: it is defined as "the
// stdio streams have ended". Settlement therefore happens on `close`, and
// `exit` only records the exit code.
//
// What is verified here:
//   1. exit_code is recorded at `exit`, before settlement.
//   2. settlement captures every byte the worker wrote, including output that
//      arrives after `exit` fired.
//   3. the on-disk snapshot matches the live job, since that snapshot is what a
//      later call or another process reads.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_ROOT, isSystemJobId } from "../src/config.mjs";
import { extractAnswer, readJob, startJob, statusOf } from "../src/jobs.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const tmpCwd = mkdtempSync(join(tmpdir(), "dsh-stdio-"));
const ANSWER = '{"outcome":"success","summary":"payload that must survive the pipe"}';
const TAIL = "PADDING-TAIL";

// The worker writes its answer, then writes again after a delay. The fake `dsh`
// wrapper is a shell that leaves a background sleeper holding the inherited
// stdout pipe, which is what makes `exit` and `close` different events.
const fakeBin = join(tmpCwd, "fake-dsh");
writeFileSync(
  fakeBin,
  `#!/bin/sh\n` +
    `sleep 1.5 &\n` +
    `exec "${process.execPath}" -e '` +
    `process.stdout.write(${JSON.stringify(ANSWER)});` +
    `setTimeout(() => { process.stdout.write(${JSON.stringify(TAIL)}); }, 400);'\n`,
  { mode: 0o755 },
);

async function until(predicate, label, timeoutMs = 10_000) {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (predicate()) return true;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const started = [];
try {
  const job = startJob({ task: "stdio-settlement", cwd: tmpCwd, timeoutMs: 30_000, dshBin: fakeBin });
  started.push(job);

  // 1) The exit code is recorded at `exit`, independently of settlement.
  await until(() => readJob(job.job_id).exit_code === 0, "the exit code to be recorded");
  assert.equal(readJob(job.job_id).exit_code, 0, "exit_code must be recorded when the process exits");

  // 2) Settlement waits for the full stream, including the delayed tail.
  await until(() => readJob(job.job_id).status !== "running", "the job to settle");
  const settled = readJob(job.job_id);
  assert.equal(settled.status, "done", `expected done, got ${settled.status}`);
  assert.equal(
    settled.stdout,
    ANSWER + TAIL,
    `the recorded answer must contain every byte written: ${JSON.stringify(settled.stdout)}`,
  );

  // 3) The persisted snapshot matches, since another call may read it instead.
  const snapshot = JSON.parse(readFileSync(join(JOB_ROOT, `${job.job_id}.json`), "utf8"));
  assert.equal(snapshot.status, "done");
  assert.equal(snapshot.stdout, ANSWER + TAIL, "the persisted snapshot must hold the complete answer");
  assert.equal(snapshot.exit_code, 0);

  // The deadline timer must not have been left armed after settlement.
  assert.equal(job.timer._destroyed, true, "the timeout timer must be cleared on settlement");
  console.log("ok - a job settles only after its stdio has fully drained");

  // extractAnswer still strips a fence and leaves plain text alone.
  assert.equal(extractAnswer('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractAnswer("plain text"), "plain text");
  assert.equal(extractAnswer(""), "");

  // statusOf surfaces the complete answer to a caller reading a settled job.
  const status = statusOf(settled);
  assert.equal(status.answer, ANSWER + TAIL, "statusOf must surface the complete answer");
  // Flags that are almost always false are omitted rather than sent as false.
  assert.equal(status.truncated, undefined, "a short answer must not be flagged as truncated");
  console.log("ok - answer extraction and status reporting survive settlement");

  // --- the persisted reader refuses ids that are not ours -------------------
  // A snapshot path is built by joining the caller's id, so an id that is not a
  // system UUID must be rejected before the join. These are pure shape checks:
  // nothing here reads a file, and no real secret path is touched.
  {
    for (const bad of [
      "../../../../etc/passwd",
      "..",
      "a/b",
      "subdir\\file",
      "./relative",
      "",
      "   ",
      "not-a-uuid",
      "11111111-1111-1111-1111-11111111111",   // one digit short
      "11111111-1111-1111-1111-1111111111111", // one digit long
      null,
      undefined,
      42,
      {},
    ]) {
      assert.equal(isSystemJobId(bad), false, `${JSON.stringify(bad)} must not be a system id`);
      assert.equal(readJob(bad), undefined, `${JSON.stringify(bad)} must read as unknown, not as a path`);
    }
    // Exactly the shape randomUUID() produces, in either case.
    for (const good of [
      "5f1c9a44-0d3e-4b21-9c77-2a6d5e8b1f30",
      "5F1C9A44-0D3E-4B21-9C77-2A6D5E8B1F30",
    ]) {
      assert.equal(isSystemJobId(good), true, `${good} must be accepted as a system id`);
    }
    // The job this test really started is still readable through the guard.
    assert.equal(readJob(job.job_id).job_id, job.job_id, "a real job id must still resolve");
    console.log("ok - only system UUIDs are joined into a job path; traversal ids read as unknown");
  }

  console.log("all stdio checks passed");
} finally {
  for (const job of started) {
    if (job.proc !== undefined && job.proc.exitCode === null && job.proc.signalCode === null) {
      try {
        job.proc.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  rmSync(tmpCwd, { recursive: true, force: true });
}
