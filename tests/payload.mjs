/**
 * Checks that what the bridge hands back is lean and still complete.
 *
 * Every tool result enters the caller's conversation and is re-sent with each
 * later request, so these pin what a reply leaves out — the worker's reasoning,
 * fields the caller already knows — and what it must never lose: the reason a
 * job failed, which lives at the very end of the worker's stderr.
 *
 * Driven over stdio against the real server, with a fake `dsh` binary; nothing
 * here calls a model or reaches the network.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { MAX_STDERR_CHARS, MAX_TAIL_CHARS } from "../src/config.mjs";
import { extractDiagnostics } from "../src/jobs.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-payload-"));
const serverPath = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

/**
 * A fake `dsh` that writes the way DSH headless does: reasoning blocks on
 * stderr while it works, an optional `dsh: CODE: message` diagnostic last, and
 * the answer on stdout. Driven by a JSON task.
 */
const fakeDsh = join(root, "fake-dsh");
writeFileSync(
  fakeDsh,
  "#!/usr/bin/env node\n" +
    "const spec = JSON.parse(process.argv.at(-1));\n" +
    "let left = spec.reasoning ?? 0;\n" +
    "while (left > 0) {\n" +
    "  const n = Math.min(left, 500);\n" +
    "  process.stderr.write('dsh: reasoning:\\n' + 'R'.repeat(n) + '\\n');\n" +
    "  left -= n;\n" +
    "}\n" +
    "if (spec.diag) process.stderr.write('dsh: ' + spec.diag + '\\n');\n" +
    "if (spec.chars) process.stdout.write('A'.repeat(spec.chars));\n" +
    "process.exitCode = spec.code ?? 0;\n",
  { mode: 0o700 },
);

const client = new Client({ name: "payload-check", version: "0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, DSH_BIN: fakeDsh, DSH_BRIDGE_STATE_DIR: join(root, "state") },
});

/** Call a tool; return both the parsed payload and the raw text sent back. */
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
  const raw = result.content[0].text;
  return { payload: JSON.parse(raw), raw };
}

const run = async (spec) => {
  const { payload: job } = await call("dsh_start", { task: JSON.stringify(spec), cwd: root });
  return call("dsh_wait", { job_id: job.job_id, max_wait_ms: 20_000 });
};

try {
  await client.connect(transport);

  // 1. Only diagnostics are extracted: reasoning, and a reasoning header cut
  // short where the kept stream begins, are never mistaken for one.
  {
    const stderr =
      "dsh: reasonin\nhalf a thought\ndsh: reasoning:\nLet me check.\n" +
      "dsh: RATE_LIMIT: 429 cap reached\ndsh: RATE_LIMIT: 429 cap reached\ndsh: PI_AI_ERROR: unavailable\n";
    assert.deepEqual(
      extractDiagnostics(stderr),
      ["RATE_LIMIT: 429 cap reached", "PI_AI_ERROR: unavailable"],
      "diagnostics are the dsh: lines that are not reasoning, each once",
    );
    assert.deepEqual(extractDiagnostics(""), []);
    console.log("ok - diagnostics exclude reasoning, a cut-off header, and repeats");
  }

  // 2. A failure says why by default, and the worker's reasoning stays out.
  {
    const { payload, raw } = await run({ reasoning: 2_000, diag: "RATE_LIMIT: 429 in-flight cap", code: 1 });
    assert.equal(payload.status, "failed");
    assert.deepEqual(payload.diagnostics, ["RATE_LIMIT: 429 in-flight cap"], "the reason for the failure is returned");
    assert.ok(!raw.includes("RRRR"), "the worker's reasoning never enters the default reply");
    console.log("ok - a failure carries its diagnostic by default, without the reasoning");
  }

  // 3. The diagnostic survives a long run: stderr keeps its end, not its start.
  {
    const { payload } = await run({ reasoning: MAX_STDERR_CHARS * 2, diag: "PI_AI_ERROR: service unavailable", code: 1 });
    assert.deepEqual(
      payload.diagnostics,
      ["PI_AI_ERROR: service unavailable"],
      "a diagnostic written after more reasoning than the buffer holds must still be kept",
    );
    console.log("ok - a diagnostic after a long stretch of reasoning is not lost");
  }

  // 4. include_logs returns the answer whole and still no reasoning.
  {
    const { payload: job } = await call("dsh_start", {
      task: JSON.stringify({ reasoning: 1_500, chars: 20_000 }),
      cwd: root,
    });
    await call("dsh_wait", { job_id: job.job_id, max_wait_ms: 20_000 });
    const { payload, raw } = await call("dsh_get", { job_id: job.job_id, include_logs: true });
    assert.equal(payload.answer.length, 20_000, "the answer comes back whole");
    assert.equal(payload.stderr, undefined, "include_logs no longer carries a stderr tail");
    assert.ok(!raw.includes("RRRR"), "and the reasoning is not in it");
    console.log("ok - include_logs returns the whole answer and no reasoning");
  }

  // 5. A normal reply omits what the caller already knows or what is false.
  {
    const { payload, raw } = await run({ chars: 30 });
    for (const field of ["cwd", "output_chars", "truncated", "answer_truncated", "stderr", "diagnostics"]) {
      assert.equal(payload[field], undefined, `a normal reply carries no ${field}`);
    }
    assert.equal(payload.answer, "A".repeat(30));
    assert.ok(!/\n\s/.test(raw), "the reply is compact JSON, not indented");
    console.log("ok - a normal reply is compact and omits known or false fields");
  }

  // 6. A background start does not echo back the directory the caller passed.
  {
    const { payload } = await call("dsh_start", { task: JSON.stringify({ chars: 1 }), cwd: root });
    assert.equal(payload.returned_inline, false);
    assert.equal(payload.cwd, undefined, "the caller passed cwd, so it is not repeated");
    await call("dsh_wait", { job_id: payload.job_id, max_wait_ms: 20_000 });
    console.log("ok - a background start omits the cwd the caller supplied");
  }

  // 7. dsh_tail honours a cap and says so.
  {
    const { payload: job } = await call("dsh_start", { task: JSON.stringify({ reasoning: 15_000 }), cwd: root });
    await call("dsh_wait", { job_id: job.job_id, max_wait_ms: 20_000 });
    const { payload } = await call("dsh_tail", { job_id: job.job_id, chars: 20_000 });
    assert.ok(payload.stderr_tail.length <= MAX_TAIL_CHARS, "a tail is never longer than the cap");
    assert.equal(payload.stderr_tail.length, MAX_TAIL_CHARS, "and gives the whole cap when there is that much");
    assert.equal(payload.chars_capped, MAX_TAIL_CHARS, "the caller is told the request was capped");
    const { payload: small } = await call("dsh_tail", { job_id: job.job_id, chars: 100 });
    assert.equal(small.chars_capped, undefined, "a request under the cap is not flagged");
    assert.equal(small.stderr_tail.length, 100);
    console.log("ok - dsh_tail is capped and says when it capped");
  }

  // 8. dsh_list is bounded, and its note is stated once rather than per row.
  {
    const { payload } = await call("dsh_list", { limit: 2 });
    assert.ok(payload.jobs.length <= 2, "rows respect the limit");
    assert.ok(payload.count >= payload.jobs.length, "the count still covers every job");
    assert.equal(typeof payload.note, "string", "the note is given once, at the top");
    for (const row of payload.workflows) assert.equal(row.note, undefined, "no row repeats it");
    console.log("ok - dsh_list is bounded and states its note once");
  }

  console.log("all payload checks passed");
} catch (error) {
  console.error("payload check FAILED:", error.message);
  process.exitCode = 1;
} finally {
  try {
    await client.close();
  } catch {
    // The transport may already be gone; the temp state is removed either way.
  }
  rmSync(root, { recursive: true, force: true });
}
