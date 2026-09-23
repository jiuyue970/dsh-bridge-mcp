/**
 * Checks that waiting returns everything, so no follow-up read is needed.
 *
 * These drive the real MCP server over stdio rather than the job functions
 * directly, because the behaviour under test lives in the tool handlers: what
 * `dsh_wait_any` chooses to put in its result is exactly the thing that
 * decided whether the caller had to spend another round trip on `dsh_get`.
 *
 * Measured motivation: over the quota window that began 2026-09-20, 181 of the
 * 1114 `dsh_get` calls directly followed a `dsh_wait_any`, because the old
 * result carried only a status and no answer.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  MAX_ANSWER_CHARS,
  MIN_SHARED_ANSWER_CHARS,
  WAIT_ANY_ANSWER_BUDGET_CHARS,
  WAIT_ANY_MAX_CHARS,
} from "../src/config.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-wait-any-"));
const stateDir = join(root, "state");
const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

/**
 * A fake `dsh` binary driven by the task text.
 *
 * `startJob` passes the task as the last argument, so a task of
 * `{"ms":200,"chars":10,"code":0}` is all the instruction this worker needs.
 * Nothing here calls a model or reaches the network.
 */
const fakeDsh = join(root, "fake-dsh");
writeFileSync(
  fakeDsh,
  "#!/usr/bin/env node\n" +
    "const spec = JSON.parse(process.argv.at(-1));\n" +
    "setTimeout(() => {\n" +
    "  if (spec.chars > 0) process.stdout.write('A'.repeat(spec.chars));\n" +
    "  if (spec.stderr) process.stderr.write(spec.stderr);\n" +
    "  process.exit(spec.code ?? 0);\n" +
    "}, spec.ms ?? 0);\n",
  { mode: 0o700 },
);

const client = new Client({ name: "wait-any-check", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DSH_BIN: fakeDsh, DSH_BRIDGE_STATE_DIR: stateDir },
});

/** Call a tool and parse the JSON payload the bridge returns. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
}

const start = (spec) => call("dsh_start", { task: JSON.stringify(spec), cwd: root });

try {
  await client.connect(transport);

  // 1. A settled job comes back from dsh_wait_any exactly as dsh_get returns it.
  {
    const job = await start({ ms: 150, chars: 40 });
    const waited = await call("dsh_wait_any", { job_ids: [job.job_id], max_wait_ms: 10_000, wait_for: "all" });
    assert.equal(waited.settled_count, 1);
    assert.equal(waited.running_count, 0);

    const fetched = await call("dsh_get", { job_id: job.job_id });
    assert.deepEqual(
      waited.settled[0],
      fetched,
      "the settled entry must be the whole dsh_get payload, or the follow-up read is still required",
    );
    assert.equal(waited.settled[0].answer, "A".repeat(40), "the answer itself is present");
    assert.equal(waited.settled[0].status, "done");
    assert.equal(waited.settled[0].exit_code, 0);
    assert.ok(waited.settled[0].ended_at, "the end time is present");
    assert.ok(!/dsh_get/.test(waited.note), `the note must not send the caller to dsh_get: ${waited.note}`);
    console.log("ok - a settled job returns from dsh_wait_any exactly as dsh_get returns it");
  }

  // 2. A failure explains itself. Without the reason the caller must re-read.
  {
    const job = await start({ ms: 100, chars: 0, code: 3, stderr: "boom" });
    const waited = await call("dsh_wait_any", { job_ids: [job.job_id], max_wait_ms: 10_000, wait_for: "all" });
    const row = waited.settled[0];
    assert.equal(row.status, "failed");
    assert.equal(row.exit_code, 3);
    assert.match(row.error, /exited with code 3/, "the failure carries its reason inline");
    console.log("ok - a failed job carries its reason, not just its status");
  }

  // 3. Several settled jobs share one answer budget, evenly and recoverably.
  {
    const loud = MAX_ANSWER_CHARS * 2;
    const jobs = await Promise.all([0, 1, 2, 3].map(() => start({ ms: 120, chars: loud })));
    const ids = jobs.map((j) => j.job_id);
    const waited = await call("dsh_wait_any", { job_ids: ids, max_wait_ms: 20_000, wait_for: "all" });
    assert.equal(waited.settled_count, 4);

    const share = Math.max(MIN_SHARED_ANSWER_CHARS, Math.floor(WAIT_ANY_ANSWER_BUDGET_CHARS / 4));
    const expected = Math.min(share, MAX_ANSWER_CHARS);
    for (const row of waited.settled) {
      assert.equal(row.answer.length, expected, "every settled job gets the same slice of the budget");
      assert.equal(row.answer_truncated, true);
      assert.equal(row.answer_chars, loud, "the true length is still reported");
      assert.equal(row.answer_omitted, loud - expected);
      assert.ok(row.answer_path.endsWith(`${row.job_id}.json`), "the rest stays reachable");
    }
    assert.equal(waited.answers_trimmed, 4, "the caller is told how many answers were trimmed");
    const answerBytes = waited.settled.reduce((sum, row) => sum + row.answer.length, 0);
    assert.ok(answerBytes <= WAIT_ANY_ANSWER_BUDGET_CHARS, `answers must stay inside the budget, got ${answerBytes}`);

    // The budget is a default, not a loss: the whole text is one read away.
    const whole = await call("dsh_get", { job_id: ids[0], include_logs: true });
    assert.equal(whole.answer.length, loud, "include_logs still returns the answer whole");
    console.log("ok - several settled answers share one budget and stay recoverable");
  }

  // 4. A single settled job is not penalised by the sharing rule.
  {
    const loud = MAX_ANSWER_CHARS * 2;
    const job = await start({ ms: 100, chars: loud });
    const waited = await call("dsh_wait_any", { job_ids: [job.job_id], max_wait_ms: 10_000, wait_for: "all" });
    assert.equal(waited.settled[0].answer.length, MAX_ANSWER_CHARS, "one job still gets the full single-job budget");
    console.log("ok - sharing never gives one job less than it would get alone");
  }

  // 5. "any" returns on the first finisher, with that job's answer already in hand.
  {
    const quick = await start({ ms: 150, chars: 12 });
    const slow = await start({ ms: 60_000, chars: 5 });
    const began = Date.now();
    const waited = await call("dsh_wait_any", { job_ids: [quick.job_id, slow.job_id], max_wait_ms: 20_000 });
    assert.ok(Date.now() - began < 10_000, "it must return on the first finisher, not the slowest");
    assert.equal(waited.settled_count, 1);
    assert.equal(waited.settled[0].job_id, quick.job_id);
    assert.equal(waited.settled[0].answer, "A".repeat(12), "the finisher's answer is already here");
    assert.deepEqual(waited.still_running, [slow.job_id], "the unfinished job is named so it can be waited on again");
    assert.match(waited.note, /dsh_wait_any again/, "the note points back at waiting, not at polling");
    await call("dsh_cancel", { job_id: slow.job_id });
    console.log("ok - the first finisher arrives complete, and the rest are named for another wait");
  }

  // 6. An expired dsh_wait window must not advertise dsh_get as the next step.
  {
    const job = await start({ ms: 60_000, chars: 5 });
    const waited = await call("dsh_wait", { job_id: job.job_id, max_wait_ms: 1_000 });
    assert.equal(waited.status, "running");
    assert.match(waited.note, /Call dsh_wait again/, "the note must steer back to waiting");
    assert.match(waited.note, /learns nothing new/, "and must say why polling does not help");
    await call("dsh_cancel", { job_id: job.job_id });
    console.log("ok - an expired wait window steers back to waiting, not to polling");
  }

  // 7. An unknown id is reported in place instead of failing the whole call.
  {
    const job = await start({ ms: 100, chars: 8 });
    const waited = await call("dsh_wait_any", {
      job_ids: [job.job_id, "00000000-0000-4000-8000-000000000000"],
      max_wait_ms: 10_000,
      wait_for: "all",
    });
    assert.equal(waited.settled_count, 2, "an unknown id is settled, not waited on forever");
    const unknown = waited.settled.find((row) => row.status === "unknown");
    assert.ok(unknown?.error, "the unknown id explains itself");
    const real = waited.settled.find((row) => row.job_id === job.job_id);
    assert.equal(real.answer, "A".repeat(8), "a real job alongside it still returns its answer");
    console.log("ok - an unknown id is reported in place without blocking the others");
  }

  // 8. The result has a ceiling, and what it drops is the least interesting work.
  {
    const count = 24;
    const loud = MAX_ANSWER_CHARS * 2;
    // One failure among the successes: it must survive the ceiling, whatever
    // order the jobs happen to settle in.
    const specs = Array.from({ length: count }, (_, i) =>
      i === count - 1 ? { ms: 120, chars: 0, code: 4, stderr: "late failure" } : { ms: 120, chars: loud },
    );
    const jobs = await Promise.all(specs.map((spec) => start(spec)));
    const ids = jobs.map((j) => j.job_id);
    const waited = await call("dsh_wait_any", { job_ids: ids, max_wait_ms: 30_000, wait_for: "all" });

    assert.equal(waited.settled_count, count, "every job settled, however the result is presented");
    assert.ok(
      JSON.stringify(waited.settled).length <= WAIT_ANY_MAX_CHARS,
      `the returned entries must respect the ceiling, got ${JSON.stringify(waited.settled).length}`,
    );
    assert.ok(waited.settled_summarised?.length > 0, "entries past the ceiling are listed as ids");
    assert.equal(
      waited.settled.length + waited.settled_summarised.length,
      count,
      "no settled job disappears; it is either returned whole or named",
    );
    const failed = waited.settled.find((row) => row.status === "failed");
    assert.ok(failed, "the failure is kept in the full list, not summarised away");
    assert.equal(failed.exit_code, 4);
    for (const stub of waited.settled_summarised) {
      assert.ok(ids.includes(stub.job_id), "a summarised entry still names a real job");
      assert.equal(stub.status, "done", "only finished, uninteresting work is summarised");
    }
    console.log("ok - the result has a ceiling, and failures are never the part it drops");
  }

  console.log("all wait-any checks passed");
} catch (error) {
  console.error("wait-any check FAILED:", error.message);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {
    // The transport may already be gone; the temp state is removed either way.
  }
  rmSync(root, { recursive: true, force: true });
}
