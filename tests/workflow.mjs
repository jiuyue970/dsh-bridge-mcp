#!/usr/bin/env node
// Offline end-to-end checks for the parent workflow controller.
//   node tests/workflow.mjs
//
// A fake DSH binary stands in for the real worker. It reads the prompt it was
// given, decides whether it is the planner or a task worker, and behaves
// accordingly — sleeping for a controlled time so overlap is observable. No
// network, no TypeSafe key, no real DSH session is created.
//
// The injected chooser returns a fixed count, so concurrency decisions are
// deterministic without a model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STATUS_LIMITS,
  __setWorkflowDeps,
  cancelWorkflow,
  readWorkflow,
  startWorkflow,
  waitWorkflow,
  workflowStatus,
} from "../src/workflow.mjs";
import { DEFAULT_PROFILE, WORKFLOW_ROOT } from "../src/config.mjs";
import { readJobLive, startJob } from "../src/jobs.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const root = mkdtempSync(join(tmpdir(), "dsh-workflow-"));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(project, "docs"), { recursive: true });
writeFileSync(join(project, "README.md"), "# fixture\n");

/**
 * The fake worker.
 *
 * Planner mode: prints the plan from FAKE_PLAN_FILE.
 * Worker mode: writes a timestamped `start`/`end` line for its task id, sleeps
 * for FAKE_WORKER_MS, then prints an evidence report. The timestamps are how
 * this test proves two workers really overlapped rather than merely both ran.
 */
const traceDir = join(root, "trace");
mkdirSync(traceDir, { recursive: true });
const planFile = join(root, "plan.json");
writeFileSync(planFile, JSON.stringify({ tasks: [] }));

const workerScript = join(root, "fake-worker.mjs");
writeFileSync(
  workerScript,
  `
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const prompt = args[args.length - 1] ?? "";
const traceDir = process.env.FAKE_TRACE_DIR;
const workMs = Number(process.env.FAKE_WORKER_MS ?? "120");
const failTask = process.env.FAKE_FAIL_TASK ?? "";
const hangTask = process.env.FAKE_HANG_TASK ?? "";

const stamp = (line) => appendFileSync(join(traceDir, "trace.log"), line + "\\n");

if (prompt.includes("You are a planning worker")) {
  if (process.env.FAKE_HANG_PLANNER === "1") {
    stamp("start planner " + Date.now() + " " + process.pid);
    // Deliberately never exits: only a cancel may end the planner.
    setInterval(() => {}, 1000);
    // Block forever so control cannot fall through to the normal planner
    // output + process.exit(0) below; the interval keeps this process alive
    // and only SIGTERM from cancelPlanner ends it.
    await new Promise(() => {});
  }
  const mode = /READ-ONLY/i.test(prompt) ? "read-only" : "write";
  if (process.env.FAKE_PLAN_FILE) {
    process.stdout.write(readFileSync(process.env.FAKE_PLAN_FILE, "utf8"));
  } else {
    process.stdout.write('{"tasks":[]}');
  }
  process.exit(0);
}

// Worker mode: recover the task id from the prompt.
const idMatch = /## Your task id\\n([^\\n]+)/.exec(prompt);
const taskId = idMatch ? idMatch[1].trim() : "unknown";

if (taskId === hangTask) {
  stamp("start " + taskId + " " + Date.now());
  // Deliberately never exits: the deadline or a cancel must end this.
  setInterval(() => {}, 1000);
} else {
  stamp("start " + taskId + " " + Date.now());
  setTimeout(() => {
    stamp("end " + taskId + " " + Date.now());
    const outcome = taskId === failTask ? "failed" : "success";
    const report = {
      outcome,
      summary: "fake worker " + taskId + " finished",
      changed_files: outcome === "success" ? ["src/" + taskId + ".js"] : [],
      checks: [{ command: "fake-check " + taskId, exit_code: outcome === "success" ? 0 : 1 }],
      artifacts: ["artifacts/" + taskId + "-report.json"],
      issues: outcome === "success" ? [] : ["simulated failure in " + taskId],
    };
    process.stdout.write(JSON.stringify(report));
    process.exit(0);
  }, workMs);
}
`,
);

/** A wrapper that makes the fake script look like a `dsh` binary. */
const fakeBin = join(root, "fake-dsh");
writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${workerScript}" "$@"\n`, { mode: 0o755 });

/** Read the start/end trace, oldest first. */
function trace() {
  try {
    return readFileSync(join(traceDir, "trace.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function resetTrace() {
  writeFileSync(join(traceDir, "trace.log"), "");
}

/** Run one workflow to completion with an injected chooser count. */
async function runWorkflow(plan, { count = 1, mode = "workspace-write", timeoutMs = 30_000, env = {}, profile } = {}) {
  writeFileSync(planFile, JSON.stringify(plan));
  process.env.FAKE_PLAN_FILE = planFile;
  process.env.FAKE_TRACE_DIR = traceDir;
  process.env.FAKE_WORKER_MS = env.workerMs ?? "150";
  process.env.FAKE_FAIL_TASK = env.failTask ?? "";
  process.env.FAKE_HANG_TASK = env.hangTask ?? "";
  process.env.FAKE_HANG_PLANNER = env.hangPlanner ?? "";

  // The chooser is injected, so no TypeSafe key or network is involved.
  __setWorkflowDeps({
    decideConcurrency: async ({ options }) => ({
      source: "test",
      count: Math.max(1, Math.min(count, options.length)),
      reason: "injected",
    }),
  });

  const workflow = startWorkflow({
    task: "Fake objective for the test",
    cwd: project,
    mode,
    allowedPaths: ["."],
    timeoutMs,
    profile,
    dshBin: fakeBin,
  });
  const outcome = await waitWorkflow(workflow.job_id, timeoutMs + 5_000);
  const { workflow: final } = readWorkflow(workflow.job_id);
  return { workflow, final, settled: outcome.settled };
}

/** Assert a trace contains a real overlap for two task ids. */
function assertOverlap(lines, a, b) {
  const span = (id) => {
    const start = lines.find((line) => line.startsWith(`start ${id} `));
    const end = lines.find((line) => line.startsWith(`end ${id} `));
    assert.ok(start, `task ${id} must have started`);
    return [Number(start.split(" ")[2]), end ? Number(end.split(" ")[2]) : Infinity];
  };
  const [aStart, aEnd] = span(a);
  const [bStart, bEnd] = span(b);
  assert.ok(
    aStart < bEnd && bStart < aEnd,
    `tasks ${a} and ${b} must truly overlap (${a}:${aStart}-${aEnd}, ${b}:${bStart}-${bEnd})`,
  );
}

/** Assert a trace shows no overlap between two task ids. */
function assertSerial(lines, a, b) {
  const span = (id) => {
    const start = lines.find((line) => line.startsWith(`start ${id} `));
    const end = lines.find((line) => line.startsWith(`end ${id} `));
    return [Number(start.split(" ")[2]), Number(end.split(" ")[2])];
  };
  const [aStart, aEnd] = span(a);
  const [bStart, bEnd] = span(b);
  assert.ok(
    aEnd <= bStart || bEnd <= aStart,
    `tasks ${a} and ${b} must not overlap (${a}:${aStart}-${aEnd}, ${b}:${bStart}-${bEnd})`,
  );
}

try {
  // 1) Two independent tasks genuinely run at the same time.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "alpha", task: "touch src/alpha", read_paths: [], write_paths: ["src/alpha"], depends_on: [] },
        { id: "beta", task: "touch docs/beta", read_paths: [], write_paths: ["docs/beta"], depends_on: [] },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 2, env: { workerMs: "400" } });
    assert.equal(final.status, "awaiting_review", `expected awaiting_review, got ${final.status}`);
    assert.equal(final.children.length, 2);
    assert.ok(final.children.every((child) => child.status === "done"), "both tasks must succeed");
    assertOverlap(trace(), "alpha", "beta");
    console.log("ok - two independent tasks really overlapped");
  }

  // 2) Dependencies are ordered: the dependent never starts before its parent ends.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "first", task: "do first", write_paths: ["src/first"], depends_on: [] },
        { id: "second", task: "do second", write_paths: ["src/second"], depends_on: ["first"] },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 2 });
    assert.equal(final.status, "awaiting_review");
    const lines = trace();
    const firstEnd = Number(lines.find((l) => l.startsWith("end first ")).split(" ")[2]);
    const secondStart = Number(lines.find((l) => l.startsWith("start second ")).split(" ")[2]);
    assert.ok(secondStart >= firstEnd, "a dependent task must not start before its dependency ends");
    assertSerial(lines, "first", "second");
    // The dependent receives its dependency's compact result.
    console.log("ok - dependency order is enforced");
  }

  // 3) Path conflicts serialise even when the chooser asks for parallelism.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "w1", task: "write shared one", write_paths: ["src/shared"], depends_on: [] },
        { id: "w2", task: "write shared two", write_paths: ["src/shared/deep"], depends_on: [] },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 2 });
    assert.equal(final.status, "awaiting_review");
    assert.equal(final.children.length, 2, "both tasks must still run, just not together");
    assertSerial(trace(), "w1", "w2");
    console.log("ok - write-conflicting tasks serialised despite a parallel request");
  }

  // 4) An illegal plan fails the workflow and starts no worker at all.
  for (const [label, badPlan] of [
    ["traversal", { tasks: [{ id: "x", task: "escape", write_paths: ["../etc"] }] }],
    ["absolute", { tasks: [{ id: "x", task: "escape", write_paths: ["/etc/passwd"] }] }],
    ["cycle", { tasks: [
      { id: "a", task: "a", depends_on: ["b"], write_paths: ["src/a"] },
      { id: "b", task: "b", depends_on: ["a"], write_paths: ["src/b"] },
    ] }],
    ["write-in-readonly", { tasks: [{ id: "x", task: "write", write_paths: ["src/x"] }] }],
  ]) {
    resetTrace();
    const mode = label === "write-in-readonly" ? "read-only" : "workspace-write";
    const { final } = await runWorkflow(badPlan, { mode });
    assert.equal(final.status, "failed", `${label}: expected failed, got ${final.status}`);
    assert.match(final.error, /rejected|reject|plan/i, `${label}: error must explain the rejection`);
    assert.equal(trace().length, 0, `${label}: no worker may be started for a rejected plan`);
  }
  console.log("ok - illegal, escaping and cyclic plans are rejected without starting workers");

  // 4a) An unusable READ no longer throws away the plan. It is dropped, the
  // drop is reported, and the workflow runs its task to the end.
  {
    resetTrace();
    const plan = {
      tasks: [
        {
          id: "r1",
          task: "read around",
          read_paths: ["src", "../sibling", "/abs/elsewhere", ".git"],
          write_paths: ["src/out.txt"],
          depends_on: [],
          acceptance: "report",
        },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 1 });
    assert.equal(final.status, "awaiting_review", "a plan with unusable reads must still run");
    assert.equal(final.children.length, 1, "its task must actually be dispatched");
    const dropped = final.plan.tasks[0].dropped_reads;
    assert.deepEqual(
      dropped.map((d) => d.path).sort(),
      ["../sibling", ".git", "/abs/elsewhere"].sort(),
      "each unusable read is recorded with its path",
    );
    assert.ok(dropped.every((d) => typeof d.reason === "string" && d.reason !== ""), "each drop keeps its reason");
    assert.deepEqual(final.plan.tasks[0].read_paths, ["src"], "the usable read survives");
    const view = workflowStatus(final, { live: false });
    assert.equal(view.dropped_read_count, 3, "the status view reports how many reads were dropped");
    console.log("ok - unusable reads are dropped and reported, and the workflow still runs");
  }

  // 4b) A plan that declares paths outside the caller's allowed_paths is
  // rejected before any worker runs. This is the scope the caller asked for,
  // enforced in code rather than merely stated in the prompt.
  for (const [label, plan, allowed, needle] of [
    [
      "outside-scope-write",
      { tasks: [{ id: "x", task: "write elsewhere", write_paths: ["docs/x.md"], depends_on: [] }] },
      ["src"],
      /outside allowed_paths/,
    ],
    [
      "parent-of-scope",
      { tasks: [{ id: "x", task: "write the parent", write_paths: ["src"], depends_on: [] }] },
      ["src/a"],
      /outside allowed_paths/,
    ],
  ]) {
    resetTrace();
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    __setWorkflowDeps({
      decideConcurrency: async ({ options }) => ({ source: "test", count: 1, reason: "injected" }),
    });
    const workflow = startWorkflow({
      task: `${label} objective`,
      cwd: project,
      mode: "workspace-write",
      allowedPaths: allowed,
      timeoutMs: 30_000,
      dshBin: fakeBin,
    });
    await waitWorkflow(workflow.job_id, 20_000);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "failed", `${label}: expected failed, got ${final.status}`);
    assert.match(final.error, needle, `${label}: the rejection must name the scope rule`);
    assert.equal(trace().length, 0, `${label}: no worker may start outside the allowed scope`);
  }
  console.log("ok - declared paths outside allowed_paths are rejected without starting workers");

  // 4c) An out-of-scope plan is never even handed to the chooser: scope is a
  // code rule, not a model judgment.
  resetTrace();
  {
    writeFileSync(
      planFile,
      JSON.stringify({
        tasks: [{ id: "x", task: "escape the scope", write_paths: ["docs/x.md"], depends_on: [] }],
      }),
    );
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    let judgments = 0;
    __setWorkflowDeps({
      decideConcurrency: async ({ options }) => {
        judgments += 1;
        return { source: "test", count: 1, reason: "injected" };
      },
    });
    const workflow = startWorkflow({
      task: "no-judgment-for-bad-scope",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["src"],
      timeoutMs: 30_000,
      dshBin: fakeBin,
    });
    await waitWorkflow(workflow.job_id, 20_000);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "failed");
    assert.equal(judgments, 0, "an out-of-scope plan must be rejected before any TypeSafe judgment");
  }
  console.log("ok - an out-of-scope plan is rejected in code before the chooser runs");

  // 5) A TypeSafe/API failure falls back to serial and is recorded as such.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "one", task: "one", write_paths: ["src/one"], depends_on: [] },
        { id: "two", task: "two", write_paths: ["docs/two"], depends_on: [] },
      ],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    __setWorkflowDeps({
      decideConcurrency: async () => ({
        source: "fallback",
        count: 1,
        reason: "TypeSafe call failed: simulated 503",
      }),
    });
    const workflow = startWorkflow({
      task: "fallback objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 30_000,
      dshBin: fakeBin,
    });
    await waitWorkflow(workflow.job_id, 35_000);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "awaiting_review");
    const fallbackDecisions = final.decisions.filter((d) => d.source === "fallback");
    assert.ok(fallbackDecisions.length >= 1, "the fallback must be recorded, not hidden");
    assert.match(fallbackDecisions[0].reason, /simulated 503/);
    assertSerial(trace(), "one", "two");
    console.log("ok - API failure recorded a serial fallback and stayed serial");
  }

  // 6) A failed task blocks its dependents; independent work still completes.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "broken", task: "will fail", write_paths: ["src/broken"], depends_on: [] },
        { id: "dependent", task: "needs broken", write_paths: ["src/dependent"], depends_on: ["broken"] },
        { id: "independent", task: "unrelated", write_paths: ["docs/independent"], depends_on: [] },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 2, env: { failTask: "broken" } });
    assert.equal(final.status, "awaiting_review");
    const byTask = Object.fromEntries(final.children.map((child) => [child.task_id, child]));
    assert.equal(byTask.broken.status, "failed", "the failing task must be recorded as failed");
    assert.equal(byTask.dependent.status, "blocked", "the dependent must be blocked, not run");
    assert.equal(byTask.independent.status, "done", "independent work must still complete");
    const startedIds = trace().filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1]);
    assert.ok(!startedIds.includes("dependent"), "a blocked dependent must never be started");
    console.log("ok - a failed task blocks dependents while independent tasks continue");
  }

  // 6b) Cancelling between the readiness check and dispatch must not be
  // reported as awaiting_review. The chooser seam is where the cancel lands: it
  // runs after the loop-top check and before any worker is started, so the
  // batch that would have started must be abandoned and the workflow settled
  // as cancelled.
  resetTrace();
  {
    const plan = {
      tasks: [{ id: "never", task: "must not run", write_paths: ["src/never"], depends_on: [] }],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    let workflowRef = null;
    let judgments = 0;
    __setWorkflowDeps({
      decideConcurrency: async ({ options }) => {
        judgments += 1;
        // The planner decides nothing here: runWorkflow calls this seam only
        // for task batches, which is exactly the window between the readiness
        // check and dispatch. Cancel on that first (and only) batch.
        //
        // The workflow must already be visible through readWorkflow by the time
        // this seam runs, otherwise the cancel would land on null and prove
        // nothing.
        assert.ok(workflowRef !== null, "the workflow must be observable before the first judgment");
        if (judgments === 1) {
          cancelWorkflow(workflowRef.job_id);
        }
        return { source: "test", count: Math.max(1, options.length), reason: "injected" };
      },
    });
    const workflow = startWorkflow({
      task: "cancel-before-dispatch objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 30_000,
      dshBin: fakeBin,
    });
    workflowRef = workflow;
    const settled = await waitWorkflow(workflow.job_id, 30_000);
    assert.equal(settled.settled, true, "a cancelled workflow must settle");
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(judgments, 1, "the chooser must actually have been reached (this is the regression)");
    assert.notEqual(final.status, "awaiting_review", "a cancelled workflow must not look reviewable");
    assert.equal(final.status, "cancelled", `expected cancelled, got ${final.status}`);
    const startedIds = trace().filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1]);
    assert.ok(!startedIds.includes("never"), "no task may start after a cancel");
    // The chooser answered synchronously, but the cancel had already landed, so
    // the decision was discarded before it could be mistaken for a dispatch.
    const syncDiscarded = (final.decisions ?? []).filter((decision) => decision.discarded === true);
    assert.equal(syncDiscarded.length, 1, "a decision taken after a cancel must be recorded as discarded");
    assert.match(syncDiscarded[0].discarded_reason, /cancelled before dispatch/);
    console.log("ok - a cancel during judgment never becomes awaiting_review");
  }

  // 6c) A cancel that lands while the TypeSafe judgment is in flight must end
  // the judgment promptly and must not dispatch the batch afterwards. The
  // chooser here never resolves on its own; it only settles once the parent
  // aborts it, which is how a real SDK call behaves.
  resetTrace();
  {
    const plan = {
      tasks: [{ id: "never2", task: "must not run either", write_paths: ["src/never2"], depends_on: [] }],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    let workflowRef = null;
    let observedSignal = null;
    let aborted = false;
    let judgmentStarted = false;
    __setWorkflowDeps({
      decideConcurrency: async ({ options, signal }) => {
        judgmentStarted = true;
        observedSignal = signal;
        return new Promise((resolve) => {
          const finish = (reason) => {
            aborted = true;
            resolve({ source: "fallback", count: 1, reason });
          };
          if (signal?.aborted) return finish("already aborted");
          signal?.addEventListener("abort", () => finish("aborted by parent"), { once: true });
          // Deliberately never resolves without an abort: only a working
          // cancel path can settle this workflow.
        });
      },
    });
    const workflow = startWorkflow({
      task: "cancel-during-judgment objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 60_000,
      dshBin: fakeBin,
    });
    workflowRef = workflow;
    // Cancel after the judgment has demonstrably started.
    for (let waited = 0; waited < 20_000 && !judgmentStarted; waited += 25) await sleep(25);
    assert.equal(judgmentStarted, true, "the judgment must have started");
    assert.ok(observedSignal, "the parent must pass an abort signal into the judgment");
    const result = cancelWorkflow(workflow.job_id);
    assert.equal(result.cancelled, true, "cancel must report success");

    const settled = await waitWorkflow(workflow.job_id, 5_000);
    assert.equal(settled.settled, true, "a cancel during judgment must settle the workflow promptly");
    assert.equal(aborted, true, "the in-flight judgment must actually be aborted");
    // The judgment is an unresolved promise, so the cancel settles the workflow
    // synchronously and then the abort resolves the chooser. The continuation
    // after `await choose(...)` therefore runs a microtask/task turn later and
    // is what writes the discard record; a bounded tick lets it run before the
    // snapshot is read. Nothing here waits on the judgment itself.
    await sleep(50);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "cancelled", `expected cancelled, got ${final.status}`);
    const startedIds = trace().filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1]);
    assert.ok(!startedIds.includes("never2"), "no worker may be dispatched after a cancel during judgment");
    // The judgment did return a count, but the workflow never acted on it. The
    // record must say so rather than reading like a batch that was started.
    const discarded = final.decisions.filter((decision) => decision.discarded === true);
    assert.equal(discarded.length, 1, "the decision taken after the cancel must be recorded as discarded");
    assert.match(discarded[0].discarded_reason, /cancelled before dispatch/);
    console.log("ok - a cancel during the TypeSafe judgment aborts it and dispatches nothing");
  }

  // 6d) The parent deadline binds the judgment too: an expired deadline must
  // settle the workflow as timed-out even though the chooser never answers.
  resetTrace();
  {
    const plan = {
      tasks: [{ id: "never3", task: "must not run", write_paths: ["src/never3"], depends_on: [] }],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    __setWorkflowDeps({
      decideConcurrency: async ({ signal }) =>
        new Promise((resolve) => {
          const finish = () => resolve({ source: "fallback", count: 1, reason: "aborted by deadline" });
          if (signal?.aborted) return finish();
          signal?.addEventListener("abort", finish, { once: true });
        }),
    });
    const workflow = startWorkflow({
      task: "deadline-during-judgment objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 1_500,
      dshBin: fakeBin,
    });
    const settled = await waitWorkflow(workflow.job_id, 20_000);
    assert.equal(settled.settled, true, "the deadline must settle the workflow");
    // Same ordering as the cancel case: the deadline settles the workflow
    // synchronously and the aborted judgment resolves on a later turn, so a
    // bounded tick is needed before the discard record is on disk.
    await sleep(50);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "timed-out", `expected timed-out, got ${final.status}`);
    const startedIds = trace().filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1]);
    assert.ok(!startedIds.includes("never3"), "no worker may start after the deadline expired");
    // Same rule as a cancel: a decision the expired deadline prevented from being
    // acted on is recorded as discarded, never as a batch that ran.
    const discardedByDeadline = (final.decisions ?? []).filter((decision) => decision.discarded === true);
    assert.equal(discardedByDeadline.length, 1, "a decision voided by the deadline must be recorded as discarded");
    assert.match(discardedByDeadline[0].discarded_reason, /deadline expired before dispatch/);
    console.log("ok - the parent deadline bounds an in-flight judgment");
  }

  // 7) Cancelling stops further dispatch and reports what it did and did not confirm.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "slow", task: "hangs", write_paths: ["src/slow"], depends_on: [] },
        { id: "later", task: "must never start", write_paths: ["src/later"], depends_on: ["slow"] },
      ],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "slow";
    __setWorkflowDeps({
      decideConcurrency: async ({ options }) => ({ source: "test", count: 1, reason: "injected" }),
    });
    const workflow = startWorkflow({
      task: "cancel objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 60_000,
      dshBin: fakeBin,
    });
    // Wait until the hanging worker is genuinely running, then cancel.
    for (let waited = 0; waited < 10_000; waited += 25) {
      if (trace().some((line) => line.startsWith("start slow "))) break;
      await sleep(25);
    }
    assert.ok(trace().some((line) => line.startsWith("start slow ")), "the slow task must have started");
    const result = cancelWorkflow(workflow.job_id);
    assert.equal(result.cancelled, true, "cancelling a live workflow must report success");
    assert.ok(
      Array.isArray(result.children_cancel_requested) && result.children_cancel_requested.length >= 1,
      "at least the running child must have a cancellation requested",
    );
    assert.ok(Array.isArray(result.children_not_confirmed), "unconfirmed cancellations must be reported");
    assert.match(result.note, /not confirmation/i, "the note must not overclaim what cancelling did");

    await sleep(600);
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "cancelled", `expected cancelled, got ${final.status}`);
    const startedIds = trace().filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1]);
    assert.ok(!startedIds.includes("later"), "a task after a cancel must never start");
    console.log("ok - parent cancel stops dispatch and honestly reports cancel scope");
  }

  // 7b) A cancel while the planner is still running must signal the planner too.
  // Its live job id is not one of `workflow.children`, so this is the regression:
  // the parent used to report `cancelled` while the planner kept running.
  resetTrace();
  {
    writeFileSync(planFile, JSON.stringify({ tasks: [] }));
    process.env.FAKE_PLAN_FILE = planFile;
    process.env.FAKE_TRACE_DIR = traceDir;
    process.env.FAKE_WORKER_MS = "120";
    process.env.FAKE_FAIL_TASK = "";
    process.env.FAKE_HANG_TASK = "";
    process.env.FAKE_HANG_PLANNER = "1";
    __setWorkflowDeps({
      decideConcurrency: async ({ options }) => ({ source: "test", count: 1, reason: "injected" }),
    });
    const workflow = startWorkflow({
      task: "cancel the planner objective",
      cwd: project,
      mode: "workspace-write",
      allowedPaths: ["."],
      timeoutMs: 60_000,
      dshBin: fakeBin,
    });
    // Wait until the planner is genuinely running, then cancel.
    const plannerLine = async () => {
      for (let waited = 0; waited < 10_000; waited += 25) {
        const found = trace().find((line) => line.startsWith("start planner "));
        if (found) return found;
        await sleep(25);
      }
      return undefined;
    };
    const startedPlanner = await plannerLine();
    assert.ok(startedPlanner, "the planner must have started");
    const plannerPid = Number(startedPlanner.split(" ")[3]);

    const { workflow: live } = readWorkflow(workflow.job_id);
    const plannerJobId = live.plan_job_id ?? live.planner_job_id;
    assert.ok(plannerJobId, "the planner job id must be recorded");
    assert.ok(
      readJobLive(plannerJobId) !== undefined,
      "the planner must be live in this process before the cancel",
    );

    const result = cancelWorkflow(workflow.job_id);
    assert.equal(result.cancelled, true, "cancelling a live workflow must report success");
    const plannerCancel = result.children_cancel_requested.find((entry) => entry.job_id === plannerJobId);
    assert.ok(plannerCancel, "the running planner must be included in the cancel report");
    assert.equal(plannerCancel.task_id, "planner", "the planner cancel must be reported as task_id='planner'");
    assert.equal(plannerCancel.pid, plannerPid, "the reported pid must be the planner process");

    // SIGTERM really ended the planner process: the job is no longer running.
    let plannerStopped = false;
    for (let waited = 0; waited < 5_000; waited += 25) {
      const job = readJobLive(plannerJobId);
      if (job === undefined || job.status !== "running") {
        plannerStopped = true;
        break;
      }
      await sleep(25);
    }
    assert.ok(plannerStopped, "the cancelled planner must no longer be running");

    // The recorded pid is gone too. Exit is not instantaneous, so this is
    // polled; a process that is still addressable after the window is force-
    // killed so this suite can never be held open by the fake planner.
    const isAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    let plannerGone = false;
    for (let waited = 0; waited < 5_000; waited += 25) {
      if (!isAlive(plannerPid)) {
        plannerGone = true;
        break;
      }
      await sleep(25);
    }
    if (!plannerGone) {
      try {
        process.kill(plannerPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      assert.fail("the planner process must not still be alive after the cancel");
    }

    const settled = await waitWorkflow(workflow.job_id, 5_000);
    assert.equal(settled.settled, true, "a cancelled workflow must settle");
    const { workflow: final } = readWorkflow(workflow.job_id);
    assert.equal(final.status, "cancelled", `expected cancelled, got ${final.status}`);
    console.log("ok - cancelling a planning workflow signals the running planner");
  }

  // 8) The parent deadline bounds the whole workflow.
  resetTrace();
  {
    const plan = {
      tasks: [{ id: "hangs", task: "hangs forever", write_paths: ["src/hangs"], depends_on: [] }],
    };
    const { final } = await runWorkflow(plan, { count: 1, timeoutMs: 2_000, env: { hangTask: "hangs" } });
    assert.ok(
      final.status === "timed-out" || final.status === "awaiting_review",
      `expected a deadline-bounded outcome, got ${final.status}`,
    );
    if (final.status === "timed-out") {
      assert.match(final.error, /deadline/i);
    } else {
      // The task itself was failed by the shared deadline rather than hanging.
      assert.equal(final.children[0].status, "failed");
      assert.match(final.children[0].reason, /deadline/i);
    }
    console.log("ok - the workflow deadline bounds planning and execution");
  }

  // 9) Final output is complete, describes every child, and never claims acceptance.
  resetTrace();
  {
    const plan = {
      tasks: [
        { id: "solo", task: "single task", write_paths: ["src/solo"], depends_on: [], acceptance: "file exists" },
      ],
    };
    const { final } = await runWorkflow(plan, { count: 1 });
    assert.equal(final.status, "awaiting_review");
    assert.equal(final.phase, "awaiting_review");
    const child = final.children[0];
    assert.equal(child.task_id, "solo");
    assert.equal(child.status, "done");
    assert.equal(child.outcome, "success");
    assert.deepEqual(child.changed_files, ["src/solo.js"]);
    assert.equal(child.checks[0].exit_code, 0);
    // Artifact paths and issues are evidence the caller reviews: they must be
    // preserved by the compaction that writes the snapshot and the evidence file.
    assert.deepEqual(child.artifacts, ["artifacts/solo-report.json"]);
    assert.deepEqual(child.issues, []);
    assert.ok(child.job_id, "the child worker job id must be reported");
    assert.ok(!/accept/i.test(final.status), "the parent must not claim acceptance");

    // The saved evidence file keeps the same arrays, and include_logs returns them.
    const evidence = JSON.parse(readFileSync(join(WORKFLOW_ROOT, final.job_id, "evidence.json"), "utf8"));
    assert.deepEqual(evidence.children[0].artifacts, ["artifacts/solo-report.json"]);
    assert.deepEqual(evidence.children[0].issues, []);
    const detail = workflowStatus(final, { live: false, includeDetail: true });
    assert.deepEqual(detail.children[0].artifacts, ["artifacts/solo-report.json"]);
    assert.deepEqual(detail.children[0].issues, []);
    console.log("ok - the workflow ends awaiting_review with complete per-task evidence");
  }

  // 9a) A profile the caller picks for the workers never reaches the planner.
  // A profile is how a DSH run gains network tools (a GitHub server that can
  // merge, say), and the read-only file sandbox does not narrow those, so a
  // write-capable profile must stop at the workers that were chosen to use it.
  resetTrace();
  {
    const booted = [];
    __setWorkflowDeps({
      startJob: (options) => {
        const job = startJob(options);
        booted.push({ job_id: job.job_id, profile: options.profile });
        return job;
      },
    });
    try {
      const plan = { tasks: [{ id: "w", task: "writes", write_paths: ["src/w"], depends_on: [] }] };
      const { final } = await runWorkflow(plan, { count: 1, profile: "write-capable-for-test" });
      assert.equal(final.status, "awaiting_review");
      const plannerId = final.plan_job_id ?? final.planner_job_id;
      const planner = booted.find((entry) => entry.job_id === plannerId);
      assert.ok(planner, "the planner's launch must be recorded");
      assert.equal(planner.profile, DEFAULT_PROFILE, "the planner boots the default profile, not the caller's");
      const worker = booted.find((entry) => entry.job_id === final.children[0].job_id);
      assert.ok(worker, "the worker's launch must be recorded");
      assert.equal(worker.profile, "write-capable-for-test", "the worker boots the profile the caller chose");
    } finally {
      __setWorkflowDeps({ startJob });
    }
    console.log("ok - a caller's profile reaches the workers and never the planner");
  }

  // 9b) A failing worker's artifact paths and unresolved issues survive into the
  // saved evidence in full, and are visible (not dropped) in include_logs.
  resetTrace();
  {
    const plan = {
      tasks: [{ id: "bad", task: "fails", write_paths: ["src/bad"], depends_on: [] }],
    };
    const { final } = await runWorkflow(plan, { count: 1, env: { failTask: "bad" } });
    assert.equal(final.status, "awaiting_review");
    const child = final.children[0];
    assert.equal(child.status, "failed");
    assert.ok(Array.isArray(child.artifacts) && child.artifacts.length > 0, "artifact paths must not be dropped");
    assert.ok(Array.isArray(child.issues) && child.issues.length > 0, "unresolved issues must not be dropped");
    assert.deepEqual(child.artifacts, ["artifacts/bad-report.json"]);
    assert.deepEqual(child.issues, ["simulated failure in bad"]);
    const evidence = JSON.parse(readFileSync(join(WORKFLOW_ROOT, final.job_id, "evidence.json"), "utf8"));
    assert.deepEqual(evidence.children[0].artifacts, ["artifacts/bad-report.json"]);
    assert.deepEqual(evidence.children[0].issues, ["simulated failure in bad"]);
    const detail = workflowStatus(final, { live: false, includeDetail: true });
    assert.deepEqual(detail.children[0].artifacts, ["artifacts/bad-report.json"]);
    assert.deepEqual(detail.children[0].issues, ["simulated failure in bad"]);
    console.log("ok - worker artifact paths and unresolved issues are preserved in the saved evidence");
  }

  // 10) The default status read stays bounded on a workflow with many children,
  // while still naming the failures first and reporting everything it trimmed.
  // A hundred synthetic children are pure data: no worker, no process, no disk.
  {
    const child = (index) => {
      const failed = index === 97;
      const blocked = index === 12;
      return {
        id: `child-${index}`,
        task_id: `task-${String(index).padStart(3, "0")}`,
        job_id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        status: failed ? "failed" : blocked ? "blocked" : "done",
        outcome: failed ? "failed" : blocked ? "blocked" : "success",
        reason: failed ? "check failed" : null,
        // A long summary and a wide check list, so the trimming is observable.
        summary: `summary ${index} `.repeat(80),
        changed_files: Array.from({ length: 40 }, (_, n) => `src/generated/deep/path/f${index}-${n}.js`),
        checks: Array.from({ length: 25 }, (_, n) => ({
          command: `check ${index}-${n} `.repeat(10),
          // The failure sits past the per-child window: it must be kept anyway.
          exit_code: failed && n === 20 ? 1 : 0,
        })),
      };
    };
    const many = {
      job_id: "0f3a1c2e-5b64-4d78-9a01-2e3f4b5c6d70",
      status: "awaiting_review",
      phase: "awaiting_review",
      created_at: "2020-01-01T00:00:00.000Z",
      ended_at: "2020-01-01T01:00:00.000Z",
      artifact_path: "/tmp/artifacts/plan.json",
      request: { cwd: project, mode: "workspace-write" },
      plan: { mode: "workspace-write", cwd: project, tasks: [] },
      children: Array.from({ length: 100 }, (_, index) => child(index)),
      decisions: Array.from({ length: 40 }, (_, index) => ({
        at: "2020-01-01T00:00:00.000Z",
        source: "typesafe",
        count: 1,
        reason: `decision ${index}`,
      })),
    };

    const compact = workflowStatus(many, { live: false });
    const compactText = JSON.stringify(compact);
    assert.ok(
      compactText.length <= STATUS_LIMITS.MAX_CHARS,
      `the default status read must stay bounded (got ${compactText.length} chars)`,
    );
    assert.equal(compact.children.length, STATUS_LIMITS.CHILDREN, "the default read caps the child list");
    assert.equal(compact.children_omitted, 100 - STATUS_LIMITS.CHILDREN, "omitted children are counted");
    assert.equal(compact.scheduling.length, STATUS_LIMITS.DECISIONS, "only recent scheduling is summarised");
    assert.equal(compact.scheduling_omitted, 40 - STATUS_LIMITS.DECISIONS, "omitted decisions are counted");
    assert.equal(compact.counts.total, 100, "the full counts are never trimmed");
    // Failures come first, so trimming cannot bury the work that needs attention.
    assert.equal(compact.children[0].task_id, "task-097", "the failed task must be presented first");
    assert.equal(compact.children[1].task_id, "task-012", "a blocked task is presented next");
    assert.ok(
      compact.children[0].checks.some((check) => check.exit_code === 1),
      "the failing check must survive trimming even when it is past the per-child window",
    );
    assert.ok(
      compact.children[0].checks.length <= STATUS_LIMITS.CHECKS_PER_CHILD,
      "the per-child check list is bounded",
    );
    assert.ok(
      compact.children[0].changed_files.length <= STATUS_LIMITS.CHANGED_FILES_PER_CHILD,
      "the per-child changed-file list is bounded",
    );
    assert.ok(compact.artifact_dir, "the complete evidence directory is always named");
    assert.match(compact.note_detail, /Summarised/, "the caller is told the view was summarised");

    // The unbounded view is still available and still complete.
    const full = workflowStatus(many, { live: false, includeDetail: true });
    assert.equal(full.children.length, 100, "includeDetail must return every child");
    assert.equal(full.decisions.length, 40, "includeDetail must return every scheduling decision");
    assert.equal(full.children[0].changed_files.length, 40, "includeDetail must not trim changed files");
    assert.equal(full.children[0].checks.length, 25, "includeDetail must not trim checks");
    assert.ok(full.children[0].summary.length > STATUS_LIMITS.FIELD_CHARS, "includeDetail keeps long text");
    assert.ok(full.plan, "includeDetail still returns the plan");
    assert.ok(!("children_omitted" in full), "a complete read reports no omissions");
    console.log("ok - the default workflow status is bounded, failure-first, and complete on request");
  }

  // 11) The two remaining unbounded fields — a long error and a cancellation
  // report listing every job — must not let the default read exceed the cap even
  // after every child and decision has been shrunk away. Pure synthetic data:
  // no worker, no process, no disk.
  {
    const longError = `planner failed: ${"stack frame ".repeat(2_000)}`;
    const cancelEntry = (index) => ({
      task_id: `task-${String(index).padStart(3, "0")}`,
      job_id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
      reason: `worker did not confirm exit ${index} `.repeat(6),
      pid: 100_000 + index,
    });
    const cancelled = {
      job_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
      status: "cancelled",
      phase: "cancelled",
      created_at: "2020-01-01T00:00:00.000Z",
      ended_at: "2020-01-01T00:30:00.000Z",
      artifact_path: "/tmp/artifacts/plan.json",
      request: { cwd: project, mode: "workspace-write" },
      plan: { mode: "workspace-write", cwd: project, tasks: [] },
      error: longError,
      cancel_report: {
        requested: Array.from({ length: 250 }, (_, index) => cancelEntry(index)),
        not_confirmed: Array.from({ length: 250 }, (_, index) => cancelEntry(index)),
      },
    };

    const compact = workflowStatus(cancelled, { live: false });
    const compactText = JSON.stringify(compact);
    assert.ok(
      compactText.length <= STATUS_LIMITS.MAX_CHARS,
      `a long error and a huge cancel report must not defeat the cap (got ${compactText.length} chars)`,
    );
    assert.ok(
      compact.error.length <= STATUS_LIMITS.FIELD_CHARS + 3,
      "the default read clips the error field",
    );
    assert.equal(compact.cancel_report.requested_count, 250, "every requested cancellation is counted");
    assert.equal(compact.cancel_report.not_confirmed_count, 250, "every unconfirmed cancellation is counted");
    assert.ok(
      compact.cancel_report.requested.length <= STATUS_LIMITS.CANCEL_ENTRIES,
      "the default read keeps only a few cancellation entries per list",
    );
    assert.equal(compact.cancel_report.requested_omitted, 250 - compact.cancel_report.requested.length);
    assert.equal(compact.cancel_report.not_confirmed_omitted, 250 - compact.cancel_report.not_confirmed.length);

    const full = workflowStatus(cancelled, { live: false, includeDetail: true });
    assert.equal(full.error, longError, "includeDetail keeps the full error");
    assert.equal(full.cancel_report.requested.length, 250, "includeDetail keeps every requested cancellation");
    assert.equal(full.cancel_report.not_confirmed.length, 250, "includeDetail keeps every unconfirmed cancellation");
    assert.deepEqual(full.cancel_report.requested[7], cancelEntry(7), "includeDetail keeps entries unclipped");
    console.log("ok - the default status bounds the error and cancel report; includeDetail keeps both whole");
  }

  console.log("all workflow checks passed");
} catch (error) {
  // Surface the failure and remember it: the finally block below must not turn a
  // failed assertion into an exit-0 pass.
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const key of [
    "FAKE_PLAN_FILE",
    "FAKE_TRACE_DIR",
    "FAKE_WORKER_MS",
    "FAKE_FAIL_TASK",
    "FAKE_HANG_TASK",
    "FAKE_HANG_PLANNER",
  ]) {
    delete process.env[key];
  }
  rmSync(root, { recursive: true, force: true });
  // A hanging fake worker (or a hung judgment) would keep this process alive
  // after the suite ends, so exit explicitly — but preserve a failed exit code.
  process.exit(process.exitCode ?? 0);
}
