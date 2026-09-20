#!/usr/bin/env node
// Restart-safety checks for persisted workflow state: node tests/snapshot.mjs
//
// A workflow snapshot outlives the process that wrote it. After a restart the
// snapshot must be reported as historical — never as a running workflow that
// can be waited on, cancelled, or resumed — and a malformed snapshot must fail
// a read rather than crash it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the state root BEFORE importing the bridge so this test and the server it
// spawns agree on where snapshots live. An MCP host may sanitize TMPDIR, which
// would otherwise send the two processes to different directories.
const stateDir = mkdtempSync(join(tmpdir(), "dsh-snapshot-state-"));
process.env.DSH_BRIDGE_STATE_DIR = stateDir;

const { WORKFLOW_ROOT, isSystemJobId } = await import("../src/config.mjs");
const { listWorkflows, readWorkflow, workflowStatus } = await import("../src/workflow.mjs");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const ids = [];
/**
 * Impersonate a previous bridge process.
 *
 * The file name must be a real system id: the reader refuses any id that is not
 * one of the UUIDs this bridge mints before it joins it into a path, so an
 * arbitrary label would test the guard instead of the snapshot behaviour. The
 * label is kept inside the snapshot body, where it is data rather than a path.
 */
function writeSnapshot(snapshot) {
  mkdirSync(WORKFLOW_ROOT, { recursive: true });
  const id = snapshot.job_id;
  assert.ok(isSystemJobId(id), `${id} must be a UUID-shaped id, as every real snapshot file is`);
  ids.push(id);
  writeFileSync(join(WORKFLOW_ROOT, `${id}.json`), JSON.stringify(snapshot));
  return id;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["bin/dsh-bridge-mcp.mjs"],
  cwd: process.cwd(),
  // The state root must be passed explicitly: the SDK does not forward TMPDIR,
  // and the bridge would otherwise resolve its own separate default.
  env: { ...process.env, DSH_BRIDGE_STATE_DIR: stateDir },
  stderr: "pipe",
});

try {
  const client = new Client({ name: "snapshot-test", version: "1.0.0" });
  await client.connect(transport);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { result, parsed, text };
  };

  // 1) A stale snapshot must not look alive, and must not be controllable.
  const staleId = writeSnapshot({
    job_id: "5f1c9a44-0d3e-4b21-9c77-2a6d5e8b1f30",
    kind: "workflow",
    status: "executing",
    phase: "executing",
    cwd: stateDir,
    created_at: "2020-01-01T00:00:00.000Z",
    ended_at: null,
    counts: { total: 1, done: 0, failed: 0, running: 1, pending: 0, blocked: 0 },
  });

  const got = await call("dsh_get", { job_id: staleId });
  assert.equal(got.result.isError ?? false, false, "reading a stale snapshot must not be an error");
  assert.equal(got.parsed.controller_alive, false, "a snapshot from another process is not live");
  assert.match(got.parsed.note, /No controller is attached/);
  assert.match(got.parsed.note, /cannot be resumed, waited on, or cancelled/);

  const waited = await call("dsh_wait", { job_id: staleId, max_wait_ms: 500 });
  assert.match(waited.parsed.note, /nothing to wait for/, "a stale snapshot must not be waited on");

  const cancelled = await call("dsh_cancel", { job_id: staleId });
  assert.equal(cancelled.parsed.cancelled, false, "a stale snapshot must not report a cancellation");
  assert.match(cancelled.parsed.reason, /previous process/);
  console.log("ok - a stale snapshot is reported as non-live and cannot be controlled");

  // 2) A malformed snapshot must degrade, not crash the reader.
  const brokenId = writeSnapshot({ job_id: "8b2d7c10-4e55-4a9f-8d31-6c0f2b7e4a19", status: "executing" });
  const broken = await call("dsh_get", { job_id: brokenId });
  assert.equal(broken.result.isError ?? false, false, "a malformed snapshot must not crash dsh_get");
  assert.ok(broken.parsed !== null, "dsh_get must still return JSON for a malformed snapshot");
  assert.equal(broken.parsed.controller_alive, false);
  assert.deepEqual(broken.parsed.children, [], "missing children must read as an empty list");
  assert.ok(broken.parsed.counts, "counts must still be reported");
  console.log("ok - a malformed snapshot degrades to an empty, clearly-historical report");

  // 3) Snapshots stay out of the worker job listing.
  const listed = await call("dsh_list", {});
  const workflowIds = listed.parsed.workflows.map((entry) => entry.job_id);
  assert.ok(workflowIds.includes(staleId), "workflows must be listed separately");
  const jobIds = listed.parsed.jobs.map((entry) => entry.job_id);
  assert.ok(
    !jobIds.includes(staleId) || !workflowIds.includes(staleId),
    "a workflow id must not be double-counted as a worker job",
  );
  assert.ok(
    !jobIds.some((id) => workflowIds.includes(id)),
    "no id may appear in both the job and workflow listings",
  );
  console.log("ok - workflow snapshots are listed separately from worker jobs");

  await client.close();

  // 4) The module-level reader refuses to invent liveness either.
  const direct = readWorkflow(staleId);
  assert.equal(direct.live, false, "readWorkflow must not claim a snapshot is live");
  const status = workflowStatus(direct.workflow, { live: false });
  assert.equal(status.controller_alive, false);
  assert.equal(status.status, "executing", "the historical phase is still reported, clearly labelled");

  // An unknown id is simply absent, not an exception.
  assert.equal(readWorkflow("no-such-workflow-id").workflow, undefined);
  assert.ok(Array.isArray(listWorkflows()), "listing must always return an array");

  // 5) A caller-supplied id is joined into a snapshot path, so an id that is not
  // a system UUID is refused before the join. This is a pure shape check: no
  // traversal target is ever read, and no real file outside the root is touched.
  for (const bad of [
    "../../../../etc/passwd",
    "../../some-other-file",
    "..",
    "a/b",
    "nested/id",
    "./relative",
    "",
    "not-a-uuid",
    "5f1c9a44-0d3e-4b21-9c77-2a6d5e8b1f3",   // one digit short
    "5f1c9a44-0d3e-4b21-9c77-2a6d5e8b1f300", // one digit long
    null,
    undefined,
    42,
  ]) {
    assert.equal(isSystemJobId(bad), false, `${JSON.stringify(bad)} must not be a system id`);
    assert.equal(
      readWorkflow(bad).workflow,
      undefined,
      `${JSON.stringify(bad)} must read as unknown rather than as a path`,
    );
  }
  // A real snapshot id still resolves through the guard.
  assert.ok(readWorkflow(staleId).workflow, "a system-shaped snapshot id must still be readable");
  console.log("ok - a non-system id can never be joined into a workflow snapshot path");
  console.log("ok - the snapshot reader is honest about liveness and tolerant of absence");

  console.log("all snapshot checks passed");
} finally {
  for (const id of ids) {
    rmSync(join(WORKFLOW_ROOT, `${id}.json`), { force: true });
    rmSync(join(WORKFLOW_ROOT, id), { recursive: true, force: true });
  }
  rmSync(stateDir, { recursive: true, force: true });
}
