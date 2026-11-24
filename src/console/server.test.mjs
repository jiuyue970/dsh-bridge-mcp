#!/usr/bin/env node
/**
 * One runnable, assert-based test for the console's HTTP surface.
 *
 *     node src/console/server.test.mjs
 *
 * The bridge is dependency-injected, so the whole HTTP surface is exercised
 * without starting a worker and without a single model call. The fake speaks
 * the *same payload shapes* the real MCP tools return — `dsh_start` returns a
 * job id, `dsh_get` returns the formatted status, `dsh_list` returns rows — so
 * the mapping under test is the one production uses. A real MCP round trip
 * against the actual server is checked with the running local console.
 *
 * Scratch directories are created under this directory and removed afterwards;
 * nothing outside it is touched.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConsoleServer, DEFAULT_CWD, PROFILE, TIERS, WORKSPACE_ROOT } from "./server.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const SCRATCH = join(APP_DIR, ".test-scratch");
const INSIDE = join(SCRATCH, "inside");
const SUB = join(INSIDE, "sub");
const ESCAPE = join(INSIDE, "escape");
const OUTSIDE = join(tmpdir(), `dsh-console-outside-${process.pid}`);
const STATE = join(SCRATCH, "state");

/* --------------------------------------------------------------------------
 * A fake bridge: the same four tools the real adapter exposes over MCP.
 * ------------------------------------------------------------------------ */

/** What the worker wrote to stdout is the answer; a fence is stripped, as dsh_get does. */
function extractAnswer(stdout) {
  const text = String(stdout ?? "").trim();
  if (text === "") return "";
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(text);
  return fenced ? fenced[1].trim() : text;
}

function makeFakeBridge() {
  const live = new Map();
  const snapshots = new Map();
  const workflows = new Map();
  const cancelPlans = new Map();
  let starts = 0;
  let cancelCalls = 0;

  const bridge = {
    lastStart: null,
    stateRoot: "/private/fake/dsh-bridge",

    /** `dsh_start`: only the job id comes back, exactly as over MCP. */
    async startJob({ task, cwd, timeoutMs, profile }) {
      starts += 1;
      bridge.lastStart = { task, cwd, timeoutMs, profile };
      const job = {
        job_id: randomUUID(),
        status: "running",
        task,
        cwd,
        created_at: new Date().toISOString(),
        ended_at: null,
        exit_code: null,
        error: null,
        stdout: "",
        stderr: "",
      };
      live.set(job.job_id, job);
      snapshots.set(job.job_id, job);
      return { job_id: job.job_id, status: job.status, pid: 4242, returned_inline: false };
    },

    /** `dsh_get`: a formatted status, not a raw snapshot. */
    async readJob(jobId) {
      const job = snapshots.get(jobId) ?? workflows.get(jobId);
      if (job === undefined) return undefined;
      const out = {
        job_id: job.job_id,
        kind: job.kind ?? "job",
        status: job.status,
        created_at: job.created_at,
        ended_at: job.ended_at ?? null,
        exit_code: job.exit_code ?? null,
      };
      if (job.phase !== undefined) out.phase = job.phase;
      if (job.counts !== undefined) out.counts = job.counts;
      if (job.children !== undefined) out.children = job.children;
      if (job.error) out.error = job.error;
      const diagnostics = String(job.stderr ?? "")
        .split("\n")
        .map((line) => /^dsh: (?!reason)(.+)$/.exec(line)?.[1]?.trim() ?? "")
        .filter((line) => line !== "");
      if (diagnostics.length > 0) out.diagnostics = diagnostics;
      const answer = extractAnswer(job.stdout);
      out.answer_chars = answer.length;
      out.answer = answer;
      return out;
    },

    /** `dsh_list`: newest first, both worker jobs and parent workflows. */
    async listJobs({ limit = 20 } = {}) {
      const all = [...snapshots.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const flows = [...workflows.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      return {
        count: all.length,
        jobs: all.slice(0, limit).map((job) => ({
          job_id: job.job_id,
          status: job.status,
          created_at: job.created_at,
          cwd: job.cwd,
          task: String(job.task ?? "").slice(0, 160),
        })),
        workflow_count: flows.length,
        workflows: flows.slice(0, limit).map((flow) => ({
          job_id: flow.job_id,
          status: flow.status,
          phase: flow.phase,
          created_at: flow.created_at,
          cwd: flow.cwd,
          counts: flow.counts ?? null,
        })),
      };
    },

    async cancelJob(jobId) {
      cancelCalls += 1;
      const plan = cancelPlans.get(jobId) ?? {
        job_id: jobId,
        cancelled: false,
        reason: "kill() reported no signal was delivered",
      };
      // A cancellation that really signalled settles the job, exactly as the
      // bridge records it; the console then reads that record back.
      if (plan.cancelled === true && snapshots.has(jobId)) {
        Object.assign(snapshots.get(jobId), {
          status: "cancelled",
          error: "cancelled by request",
          ended_at: new Date().toISOString(),
        });
      }
      return plan;
    },

    async close() {},
  };

  // Live counters: assigning a plain number would freeze it at its initial
  // value and every count below would silently read zero.
  Object.defineProperties(bridge, {
    starts: { get: () => starts, enumerable: true },
    cancelCalls: { get: () => cancelCalls, enumerable: true },
  });

  /** Record a real settlement on the fake's snapshot, the way close() would. */
  bridge.settle = (jobId, patch) => {
    Object.assign(snapshots.get(jobId), patch);
  };
  /** Put a job in the shared store that this console never created. */
  bridge.addExternal = (patch = {}) => {
    const job = {
      job_id: randomUUID(),
      status: "done",
      cwd: "/Volumes/Untitled/zido/other",
      created_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      exit_code: 0,
      stdout: "```\nwork from another MCP client\n```",
      stderr: "",
      error: null,
      ...patch,
    };
    snapshots.set(job.job_id, job);
    return job.job_id;
  };
  /** Put a parent workflow in the shared store that this console never created. */
  bridge.addExternalWorkflow = (patch = {}) => {
    const flow = {
      job_id: randomUUID(),
      kind: "workflow",
      status: "awaiting_review",
      phase: "review",
      cwd: "/Volumes/Untitled/zido/other",
      created_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
      stdout: "",
      stderr: "",
      error: null,
      counts: { done: 1, failed: 0 },
      children: [{ task_id: "read", status: "done", evidence: { summary: "verified file read" } }],
      ...patch,
    };
    workflows.set(flow.job_id, flow);
    return flow.job_id;
  };
  bridge.planCancel = (jobId, plan) => {
    cancelPlans.set(jobId, plan);
  };
  bridge.settleActive = () => {
    for (const job of snapshots.values()) {
      if (job.status === "running") Object.assign(job, { status: "done", ended_at: new Date().toISOString(), exit_code: 0 });
    }
  };
  bridge.snapshots = snapshots;
  bridge.workflows = workflows;
  bridge.adopt = (other) => {
    for (const [id, job] of other.snapshots) snapshots.set(id, { ...job });
    for (const [id, flow] of other.workflows) workflows.set(id, { ...flow });
  };
  return bridge;
}

/* --------------------------------------------------------------------------
 * Minimal HTTP client. node:http rather than fetch, because Host and Origin
 * are exactly the headers under test and fetch refuses to set them.
 * ------------------------------------------------------------------------ */

function call(port, method, path, { body, headers = {}, marker = true } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const all = { ...(method === "POST" && marker ? { "x-agent-console": "1" } : {}), ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === "string" ? body : JSON.stringify(body);
      all["content-type"] = "application/json";
      all["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = request({ host: "127.0.0.1", port, method, path, headers: all }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          json = null;
        }
        resolvePromise({ status: res.statusCode, headers: res.headers, json, raw });
      });
    });
    req.on("error", rejectPromise);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const submit = (port, body, options) => call(port, "POST", "/api/jobs", { body, ...options });

/* --------------------------------------------------------------------------
 * Checks.
 * ------------------------------------------------------------------------ */

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("GET /api/info reports the backend, the MCP transport and no model claim", async (port) => {
  const res = await call(port, "GET", "/api/info");
  assert.equal(res.status, 200);
  const info = res.json;
  assert.equal(info.backend, "DSH");
  assert.equal(info.profile, PROFILE);
  assert.equal(info.model, null, "no model is claimed when none is known");
  assert.equal(info.transport, "MCP stdio");
  assert.ok(String(info.mcpEntry).endsWith("bin/dsh-bridge-mcp.mjs"), "the console names the MCP entry it drives");
  assert.ok(String(info.bridgeStateRoot).endsWith("dsh-bridge"), "the shared state root is reported");
  assert.equal(info.workspaceRoot, WORKSPACE_ROOT);
  assert.equal(info.defaultCwd, DEFAULT_CWD);
  assert.ok(!res.raw.includes("environment") && !res.raw.includes("settings"), "info must not expose settings");
});

check("invalid cwd is rejected before anything is dispatched", async (port, bridge) => {
  const base = { role: "worker", task: "look around", clientRequestId: randomUUID() };
  const before = bridge.starts;

  const outside = await submit(port, { ...base, clientRequestId: randomUUID(), cwd: OUTSIDE });
  assert.equal(outside.status, 400, "a directory outside the workspace root must be refused");

  const escape = await submit(port, { ...base, clientRequestId: randomUUID(), cwd: ESCAPE });
  assert.equal(escape.status, 400, "a symlink out of the workspace must be refused");
  assert.match(escape.json.error, /inside/);

  const missing = await submit(port, { ...base, clientRequestId: randomUUID(), cwd: join(SUB, "nope") });
  assert.equal(missing.status, 400, "a missing directory must be refused");

  const file = await submit(port, { ...base, clientRequestId: randomUUID(), cwd: join(SUB, "note.txt") });
  assert.equal(file.status, 400, "a file is not a cwd");

  const relative = await submit(port, { ...base, clientRequestId: randomUUID(), cwd: "sub" });
  assert.equal(relative.status, 400, "cwd must be absolute");

  assert.equal(bridge.starts, before, "no rejected submission may reach the dispatcher");
});

check("malformed submissions are refused without dispatching", async (port, bridge) => {
  const before = bridge.starts;
  const cwd = SUB;
  const bad = [
    [{ role: "supervisor", task: "x", cwd, clientRequestId: randomUUID() }, "unknown role"],
    [{ role: "main", task: "", cwd, clientRequestId: randomUUID() }, "empty task"],
    [{ role: "main", task: "x".repeat(12_001), cwd, clientRequestId: randomUUID() }, "oversized task"],
    [{ role: "main", task: "x", cwd, clientRequestId: "not-a-uuid" }, "bad clientRequestId"],
    [{ role: "main", gate: "before_plan", task: "x", cwd, clientRequestId: randomUUID() }, "gate on a non-architect"],
    [{ role: "architect", task: "x", cwd, clientRequestId: randomUUID() }, "architect without a gate"],
    [{ role: "architect", gate: "whenever", task: "x", cwd, clientRequestId: randomUUID() }, "unknown gate"],
    [{ role: "main", task: "x", cwd: SUB, clientRequestId: randomUUID(), sourceJobId: randomUUID() }, "sourceJobId on a non-architect"],
    ["not json at all", "unparseable body"],
    [[1, 2, 3], "array body"],
  ];
  for (const [body, why] of bad) {
    const res = await submit(port, body);
    assert.equal(res.status, 400, `${why} must be refused`);
    assert.equal(typeof res.json.error, "string");
  }
  assert.equal(bridge.starts, before, "no refused submission may reach the dispatcher");

  const huge = await submit(port, JSON.stringify({ role: "main", task: "x", cwd, clientRequestId: randomUUID(), pad: "y".repeat(200_000) }));
  assert.equal(huge.status, 413, "an oversized body must be refused");
});

check("mutations require the console marker and a same-origin request", async (port) => {
  const body = { role: "worker", task: "x", cwd: SUB, clientRequestId: randomUUID() };
  const noMarker = await submit(port, body, { marker: false });
  assert.equal(noMarker.status, 403);
  assert.match(noMarker.json.error, /X-Agent-Console/);

  const badOrigin = await submit(port, { ...body, clientRequestId: randomUUID() }, {
    headers: { origin: "http://evil.example" },
  });
  assert.equal(badOrigin.status, 403, "a cross-origin mutation must be refused");

  const badHost = await call(port, "GET", "/api/jobs", { headers: { host: "evil.example" } });
  assert.equal(badHost.status, 403, "a rebound host must be refused");

  const goodOrigin = await submit(port, { ...body, clientRequestId: randomUUID() }, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(goodOrigin.status, 200, "same-origin is accepted");
  assert.equal(goodOrigin.headers["access-control-allow-origin"], undefined, "no CORS headers");
});

check("a submission becomes exactly one headless job with a wrapped task", async (port, bridge) => {
  const before = bridge.starts;
  const res = await submit(port, {
    role: "worker",
    task: "Fix the parse bug in parser.mjs and nothing else.",
    cwd: SUB,
    clientRequestId: randomUUID(),
  });
  assert.equal(res.status, 200);
  assert.equal(bridge.starts, before + 1, "one submission starts one job");

  const job = res.json.job;
  assert.equal(job.role, "worker");
  assert.equal(job.source, "本界面");
  assert.equal(job.owned, true);
  assert.equal(job.gate, null);
  assert.equal(job.cwd, SUB);
  assert.equal(job.status, "running");
  assert.equal(job.cancel_supported, true, "this console created it, so a handle exists behind it");
  assert.equal(job.state_unconfirmed, false);
  assert.equal(job.answer, "");

  const start = bridge.lastStart;
  assert.equal(start.profile, PROFILE, "the DSH profile is passed through unchanged");
  assert.equal(start.timeoutMs, TIERS.edit, "write roles reuse the bridge's edit budget");
  assert.equal(start.cwd, SUB);
  assert.ok(
    start.task.includes("Fix the parse bug in parser.mjs and nothing else."),
    "the objective is passed through verbatim",
  );
  assert.ok(start.task.includes("ROLE: worker"), "the role is stated");
  assert.ok(start.task.includes("Edit files only inside the working directory"), "the worker is scoped");
  assert.ok(start.task.includes("stay unapplied"), "the unapproved configuration stays unapplied");
  assert.ok(!/\b(Sol|Luna|Astra)\b/.test(start.task), "no invented model identity is claimed");
});

check("read-only roles get the investigate budget and a read-only brief", async (port, bridge) => {
  const res = await submit(port, {
    role: "explorer",
    task: "Explain how routing works here.",
    cwd: SUB,
    clientRequestId: randomUUID(),
  });
  assert.equal(res.status, 200);
  assert.equal(bridge.lastStart.timeoutMs, TIERS.investigate, "read-only roles reuse the investigate budget");
  assert.ok(bridge.lastStart.task.includes("strictly READ-ONLY"));
});

check("a repeated clientRequestId never starts a second worker", async (port, bridge) => {
  const clientRequestId = randomUUID();
  const payload = { role: "main", task: "Do the one thing.", cwd: SUB, clientRequestId };
  const before = bridge.starts;

  const first = await submit(port, payload);
  const second = await submit(port, payload);
  const third = await submit(port, { ...payload });

  assert.equal(bridge.starts, before + 1, "two submissions, one dispatch");
  assert.equal(second.json.job.job_id, first.json.job.job_id, "the repeat returns the same job");
  assert.equal(third.json.job.job_id, first.json.job.job_id, "a re-send returns the same job");
  assert.equal(second.json.job.status, "running", "a repeated submission still belongs to this process");
  assert.equal(second.json.job.cancel_supported, true, "a repeated submission retains its cancel handle");
});

check("concurrent re-sends of one clientRequestId still start one worker", async (port, bridge) => {
  const clientRequestId = randomUUID();
  const payload = { role: "main", task: "Only once.", cwd: SUB, clientRequestId };
  const before = bridge.starts;
  const [a, b, c] = await Promise.all([submit(port, payload), submit(port, payload), submit(port, { ...payload })]);
  assert.equal(bridge.starts, before + 1, "three concurrent requests, one worker");
  const ids = new Set([a.json.job.job_id, b.json.job.job_id, c.json.job.job_id]);
  assert.equal(ids.size, 1, "every caller is given the same job id");
});

check("a task this console never created is visible, readable and uncancellable", async (port, bridge) => {
  const externalId = bridge.addExternal();
  const flowId = bridge.addExternalWorkflow();
  const cancelBefore = bridge.cancelCalls;

  const listed = await call(port, "GET", "/api/jobs");
  assert.equal(listed.status, 200);
  const external = listed.json.jobs.find((job) => job.job_id === externalId);
  const flow = listed.json.jobs.find((job) => job.job_id === flowId);
  assert.ok(external, "an external MCP job appears in the listing");
  assert.ok(flow, "an external parent workflow appears in the listing");
  assert.equal(external.source, "MCP共享状态");
  assert.equal(external.role, "unknown", "no role is invented for an external task");
  assert.equal(external.owned, false);
  assert.equal(external.cancel_supported, false, "no handle here, so no cancellation here");
  assert.equal(external.snapshot, true, "its state is a snapshot, and says so");
  assert.equal(external.detail_loaded, false, "a listing row carries no answer until it is read");
  assert.equal(flow.kind, "workflow");
  const flowRead = await call(port, "GET", `/api/jobs/${flowId}`);
  assert.equal(flowRead.json.job.workflow_result.children[0].evidence.summary, "verified file read");

  const read = await call(port, "GET", `/api/jobs/${externalId}`);
  assert.equal(read.status, 200, "an external job is readable through dsh_get");
  assert.equal(read.json.job.status, "done");
  assert.equal(read.json.job.answer, "work from another MCP client", "the real answer is shown");
  assert.equal(read.json.job.detail_loaded, true);
  assert.equal(read.json.job.cancel_supported, false);

  const cancel = await call(port, "POST", `/api/jobs/${externalId}/cancel`, { body: {} });
  assert.equal(cancel.status, 409, "an external task cannot be cancelled through this process");
  assert.match(cancel.json.error, /another MCP client/);
  assert.equal(cancel.json.job.cancel_supported, false);
  assert.equal(bridge.cancelCalls, cancelBefore, "dsh_cancel is never called for an external task");

  const nonsense = await call(port, "GET", "/api/jobs/..%2F..%2Fetc%2Fpasswd");
  assert.equal(nonsense.status, 404, "a traversal-shaped id is simply not a job");
  const missing = await call(port, "POST", `/api/jobs/${randomUUID()}/cancel`, { body: {} });
  assert.equal(missing.status, 404, "an unknown id is still a 404");
  assert.equal(bridge.cancelCalls, cancelBefore, "a 404 never reaches dsh_cancel either");

  const cancelForeign = await submit(port, {
    role: "architect",
    gate: "before_plan",
    task: "Review it.",
    cwd: SUB,
    clientRequestId: randomUUID(),
    sourceJobId: externalId,
  });
  assert.equal(cancelForeign.status, 400, "an external sourceJobId cannot be review context");
});

check("an external snapshot that claims to be running is labelled and does not block writers", async (port, bridge) => {
  const runningId = bridge.addExternal({
    status: "running",
    ended_at: null,
    exit_code: null,
    stdout: "",
    created_at: new Date().toISOString(),
  });

  const listed = await call(port, "GET", "/api/jobs");
  const row = listed.json.jobs.find((job) => job.job_id === runningId);
  assert.ok(row, "a snapshot that still says running is still listed");
  assert.equal(row.status, "running", "the state is reported as the bridge reports it");
  assert.equal(row.snapshot, true, "and is labelled as a snapshot, not as a live handle");
  assert.equal(row.cancel_supported, false);

  const read = await call(port, "GET", `/api/jobs/${runningId}`);
  assert.equal(read.json.job.snapshot_status, "running", "the snapshot's own status is kept alongside");
  assert.match(read.json.job.note, /快照/);

  const cancelBefore = bridge.cancelCalls;
  const res = await submit(port, { role: "worker", task: "Write here.", cwd: SUB, clientRequestId: randomUUID() });
  assert.equal(res.status, 200, "an unrelated external run must not block this console's own writer");
  assert.equal(bridge.cancelCalls, cancelBefore);
});

check("overlapping writers are refused while independent scopes and readers can run", async (port, bridge) => {
  const start = (role, cwd) => submit(port, { role, cwd, task: "Execute this scoped task.", clientRequestId: randomUUID() });
  const first = await start("worker", SUB);
  assert.equal(first.status, 200);
  const before = bridge.starts;
  assert.equal((await start("main", SUB)).status, 409);
  assert.equal((await start("worker", INSIDE)).status, 409);
  assert.equal(bridge.starts, before, "conflicting writes are rejected before dispatch");
  assert.equal((await start("explorer", SUB)).status, 200, "a reader can run alongside a writer");
  const other = join(INSIDE, "other");
  mkdirSync(other, { recursive: true });
  assert.equal((await start("worker", other)).status, 200, "independent directories can be written in parallel");

  bridge.settle(first.json.job.job_id, { status: "done", ended_at: new Date().toISOString(), exit_code: 0 });
  assert.equal((await start("main", SUB)).status, 200, "a settled writer releases its directory");
});

check("a real failure is preserved as a failure, with its exit code", async (port, bridge) => {
  const created = await submit(port, {
    role: "worker",
    task: "Try the change.",
    cwd: SUB,
    clientRequestId: randomUUID(),
  });
  const jobId = created.json.job.job_id;
  bridge.settle(jobId, {
    status: "failed",
    error: "exited with code 1",
    exit_code: 1,
    ended_at: new Date().toISOString(),
    stdout: "```\nI edited one file and then stopped.\n```",
    stderr: "dsh: PI_AI_ERROR: provider call failed\n",
  });

  const res = await call(port, "GET", `/api/jobs/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.job.status, "failed", "a failure is never dressed up as done");
  assert.equal(res.json.job.error, "exited with code 1");
  assert.equal(res.json.job.exit_code, 1);
  assert.equal(res.json.job.answer, "I edited one file and then stopped.");
  assert.equal(res.json.job.cancel_supported, false, "a settled job cannot be cancelled");
  assert.deepEqual(res.json.job.diagnostics, ["PI_AI_ERROR: provider call failed"]);
  assert.equal(res.json.job.stderr, undefined, "raw stderr is never served");
  assert.equal(res.json.job.stdout, undefined, "raw stdout is never served");
  assert.equal(res.json.job.args, undefined, "no invocation detail is served");
});

check("a refused cancellation is reported as refused, not as cancelled", async (port, bridge) => {
  const created = await submit(port, {
    role: "main",
    task: "Keep going.",
    cwd: SUB,
    clientRequestId: randomUUID(),
  });
  const jobId = created.json.job.job_id;
  bridge.planCancel(jobId, { job_id: jobId, cancelled: false, reason: "process has already exited" });

  const res = await call(port, "POST", `/api/jobs/${jobId}/cancel`, { body: {} });
  assert.equal(res.status, 409, "a refusal is not a success");
  assert.match(res.json.error, /process has already exited/, "the real reason is reported");
  assert.equal(res.json.job.status, "running", "the job is not relabelled cancelled");
  assert.equal(res.json.job.cancel_supported, true);
});

check("a cancellation that really signalled reads back the bridge's own record", async (port, bridge) => {
  const created = await submit(port, {
    role: "main",
    task: "Stop when told.",
    cwd: SUB,
    clientRequestId: randomUUID(),
  });
  const jobId = created.json.job.job_id;
  bridge.planCancel(jobId, { job_id: jobId, cancelled: true, pid: 4242, signal: "SIGTERM" });

  const res = await call(port, "POST", `/api/jobs/${jobId}/cancel`, { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.job.status, "cancelled", "the reported status is the bridge's, not an assertion");
});

check("restart preserves terminal results and marks active records unconfirmed", async (port, bridge) => {
  const active = await submit(port, { role: "explorer", task: "Read this file.", cwd: SUB, clientRequestId: randomUUID() });
  assert.equal(active.status, 200);
  const restored = makeFakeBridge();
  restored.adopt(bridge);
  const app = await createConsoleServer({ dispatcher: restored, tiers: TIERS, stateDir: STATE });
  const bound = await app.listen(0);
  try {
    const res = await call(bound.port, "GET", "/api/jobs");
    assert.equal(res.status, 200);
    assert.ok(res.json.jobs.length > 0, "records outlive the process that created them");
    for (const job of res.json.jobs) {
      if (!job.owned) continue;
      if (job.job_id === active.json.job.job_id) {
        assert.equal(job.status, "unknown-after-restart", "a restarted process cannot confirm an active handle");
        assert.equal(job.state_unconfirmed, true);
        assert.equal(job.snapshot_status, "running");
      } else {
        assert.notEqual(job.status, "unknown-after-restart", "terminal results survive restart");
        assert.equal(job.state_unconfirmed, false);
      }
      assert.equal(job.cancel_supported, false, "a restarted process holds no handle");
      assert.equal(job.snapshot, true, "what is left is a snapshot");
      assert.equal(typeof job.created_at, "string");
      assert.ok(["main", "explorer", "worker", "researcher", "architect"].includes(job.role));
    }

    // Nothing is re-dispatched on a restart: an unconfirmed task is never re-run.
    assert.equal(app.dispatcher.starts, 0, "a restart must not re-dispatch anything");

    const cancel = await call(bound.port, "POST", `/api/jobs/${active.json.job.job_id}/cancel`, { body: {} });
    assert.equal(cancel.status, 409, "cancelling an unowned job is refused, not pretended");
    assert.equal(app.dispatcher.cancelCalls, 0, "no signal is sent for a job this process did not start");
  } finally {
    await app.close();
  }
});

check("the state file holds only app-owned metadata", async () => {
  const raw = readFileSync(join(STATE, "records.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.records) && parsed.records.length > 0);
  const allowed = new Set(["job_id", "role", "gate", "cwd", "created_at", "clientRequestId", "sourceJobId"]);
  for (const record of parsed.records) {
    for (const key of Object.keys(record)) {
      assert.ok(allowed.has(key), `unexpected persisted field: ${key}`);
    }
    assert.ok(!("task" in record), "task text is not persisted here");
    assert.ok(!("answer" in record), "outputs are not persisted here");
  }
  assert.ok(!/KEY|TOKEN|SECRET|PASSWORD/i.test(raw), "no credential-shaped text is persisted");
});

check("the page polls for external tasks even while nothing of its own is running", async (port) => {
  const page = await call(port, "GET", "/");
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes("<!DOCTYPE html") || page.raw.includes("<!doctype html"), "the page is served");

  // The poller must not be gated on this console having work of its own: an
  // external MCP call can start at any moment, and nothing local would notice.
  const start = page.raw.indexOf("function syncPoll()");
  assert.ok(start > -1, "the console still owns its poller");
  const body = page.raw.slice(start, page.raw.indexOf("function renderAll", start));
  assert.ok(body.includes("window.setInterval"), "the poller installs its interval");
  assert.ok(!body.includes("anyActive()"), "the poller does not sleep while this console is idle");

  assert.ok(page.raw.includes("ensureDetail("), "an external row is completed by reading its detail");
  assert.ok(page.raw.includes("外部 MCP 任务 · 本进程不可取消"), "cancelling an external task is impossible from the page");
});

/* --------------------------------------------------------------------------
 * Runner.
 * ------------------------------------------------------------------------ */

async function main() {
  mkdirSync(SUB, { recursive: true });
  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(SUB, "note.txt"), "x");
  symlinkSync(OUTSIDE, ESCAPE, "dir");

  const bridge = makeFakeBridge();
  const app = await createConsoleServer({ dispatcher: bridge, tiers: TIERS, stateDir: STATE });
  const bound = await app.listen(0);
  process.stdout.write(`listening on ${bound.url} (ephemeral)\n\n`);

  let failed = 0;
  try {
    for (const { name, fn } of checks) {
      try {
        await fn(bound.port, bridge);
        process.stdout.write(`ok    ${name}\n`);
      } catch (error) {
        failed += 1;
        process.stdout.write(`FAIL  ${name}\n      ${error?.message ?? error}\n`);
      } finally {
        bridge.settleActive();
      }
    }
  } finally {
    await app.close();
    rmSync(SCRATCH, { recursive: true, force: true });
    rmSync(OUTSIDE, { recursive: true, force: true });
  }

  process.stdout.write(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  rmSync(SCRATCH, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
  process.stderr.write(`test harness failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});
