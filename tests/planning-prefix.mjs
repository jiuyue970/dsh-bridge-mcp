#!/usr/bin/env node
// Checks the code-synthesised plan path: when a plan can be built from what the
// caller already stated, no planning worker is started at all.
//   node tests/planning-prefix.mjs
//
// The planner is a whole DSH run, so every workflow that starts one pays a full
// extra serial round trip (measured p50 155s, p90 387s over 672 recorded
// planners). This file pins the cases where that run is skipped, and the one
// case where it is not.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setWorkflowDeps,
  readWorkflow,
  startWorkflow,
  waitWorkflow,
  workflowStatus,
} from "../src/workflow.mjs";
import { DEFAULT_DECOMPOSE, SYNTHESIZED_TASK_ID } from "../src/config.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-planprefix-"));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(project, "docs"), { recursive: true });
writeFileSync(join(project, "README.md"), "# fixture\n");

const traceFile = join(root, "trace.log");
writeFileSync(traceFile, "");

// String.raw keeps the escapes intact: the written file is itself JavaScript, so
// the escapes it contains have to survive this one extra round of embedding.
const workerSource = String.raw`import { appendFileSync } from "node:fs";

const prompt = process.argv[process.argv.length - 1] ?? "";

if (prompt.includes("You are a planning worker")) {
  appendFileSync(process.env.FAKE_TRACE, "planner\n");
  process.stdout.write(process.env.FAKE_PLAN ?? "{\"tasks\":[]}");
  process.exit(0);
}

const id = /## Your task id\n([^\n]+)/.exec(prompt);
appendFileSync(process.env.FAKE_TRACE, "worker " + (id ? id[1].trim() : "unknown") + "\n");
process.stdout.write(JSON.stringify({
  outcome: "success",
  summary: "did it",
  changed_files: [],
  checks: [{ command: "fake", exit_code: 0 }],
  artifacts: [],
  issues: [],
}));
process.exit(0);
`;

const workerScript = join(root, "fake-worker.mjs");
writeFileSync(workerScript, workerSource);

const fakeBin = join(root, "fake-dsh");
writeFileSync(fakeBin, '#!/bin/sh\nexec "' + process.execPath + '" "' + workerScript + '" "$@"\n', { mode: 0o755 });

process.env.FAKE_TRACE = traceFile;
process.env.FAKE_PLAN = JSON.stringify({
  tasks: [
    { id: "planned", task: "the planner decided this", read_paths: ["README.md"], write_paths: [], depends_on: [] },
  ],
});

const trace = () => readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean);
const plannersStarted = () => trace().filter((line) => line === "planner").length;
const workersStarted = () => trace().filter((line) => line.startsWith("worker ")).length;

async function run({ mode, allowedPaths, decompose, task = "Do the one thing the caller described." }) {
  writeFileSync(traceFile, "");
  __setWorkflowDeps({
    decideConcurrency: async ({ options }) => ({
      source: "test",
      count: Math.max(1, options.length),
      reason: "injected",
    }),
  });
  const workflow = startWorkflow({
    task,
    cwd: project,
    mode,
    allowedPaths,
    decompose,
    timeoutMs: 30_000,
    dshBin: fakeBin,
  });
  await waitWorkflow(workflow.job_id, 25_000);
  const { workflow: final } = readWorkflow(workflow.job_id);
  return { final, status: workflowStatus(final, { live: false }) };
}

try {
  // 1) The default is off, and that is the whole point of the change.
  assert.equal(DEFAULT_DECOMPOSE, false, "decompose must default to false");

  // 2) read-only, default: no planner, one synthesised task, the work runs.
  {
    const { final, status } = await run({ mode: "read-only", allowedPaths: ["."] });
    // The trace is the ground truth: it records which processes actually ran.
    const seen = () =>
      "trace=" + JSON.stringify(trace()) + " status=" + final.status + " error=" + final.error;
    assert.equal(plannersStarted(), 0, "read-only must not start a planner: " + seen());
    assert.equal(workersStarted(), 1, "exactly one worker must run: " + seen());
    assert.equal(final.status, "awaiting_review", "got " + final.status + ": " + final.error);
    assert.equal(final.plan_source, "code", "the plan must be recorded as code-built");
    assert.equal(final.children[0].status, "done", "the single task must complete");
    assert.equal(status.plan_source, "code", "a status read must say where the plan came from");
    assert.match(status.note, /no planner/i, "the status must say the planning run was skipped");
    console.log("ok - a read-only workflow skips the planner and runs one code-built task");
  }

  // 3) workspace-write scoped to a subpath: synthesised, and the write scope is
  //    exactly the caller's grant.
  {
    const { final } = await run({ mode: "workspace-write", allowedPaths: ["src"] });
    assert.equal(plannersStarted(), 0, "a named subpath needs no planner");
    assert.equal(final.status, "awaiting_review", "got " + final.status + ": " + final.error);
    assert.equal(final.plan_source, "code");
    assert.deepEqual(final.plan.tasks[0].write_paths, ["src"], "the write scope must be the caller's grant");
    assert.equal(final.plan.tasks[0].id, SYNTHESIZED_TASK_ID);
    console.log("ok - a workspace-write scope that names a subpath is synthesised without a planner");
  }

  // 4) workspace-write with a bare "." cannot be synthesised: validatePlan
  //    refuses a task that declares the whole cwd as its write path, and there
  //    is no honest subpath without reconnaissance. It must plan, as before.
  {
    const { final } = await run({ mode: "workspace-write", allowedPaths: ["."] });
    assert.equal(plannersStarted(), 1, 'a bare "." write scope must fall back to the planner');
    assert.equal(final.plan_source, "planner", "the fallback must be recorded honestly");
    assert.match(final.plan_note, /no subpath/i, "the reason for falling back must be recorded");
    assert.equal(final.status, "awaiting_review", "got " + final.status + ": " + final.error);
    console.log('ok - a bare dot write scope still plans, and says why');
  }

  // 5) decompose: true keeps the planner reachable even where a plan could
  //    have been synthesised.
  {
    const { final } = await run({ mode: "read-only", allowedPaths: ["."], decompose: true });
    assert.equal(plannersStarted(), 1, "decompose:true must start the planner");
    assert.equal(final.plan_source, "planner");
    assert.equal(final.children[0].task_id, "planned", "the planner's own split must be used");
    assert.equal(final.status, "awaiting_review", "got " + final.status + ": " + final.error);
    console.log("ok - decompose:true still plans first, on the unchanged planner path");
  }

  // 6) The synthesised task is the caller's own words, not a model's rewrite.
  {
    const task = "Rename the export in src/a.js and update its two importers.";
    const { final } = await run({ mode: "read-only", allowedPaths: ["."], task });
    assert.equal(plannersStarted(), 0);
    assert.equal(final.plan.tasks[0].task, task, "the objective must reach the worker verbatim");
    assert.deepEqual(final.plan.tasks[0].depends_on, []);
    console.log("ok - the synthesised task carries the caller's objective verbatim");
  }

  console.log("all planning-prefix checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
