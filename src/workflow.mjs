import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  DEFAULT_PLANNING_TIMEOUT_MS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_ARTIFACT_ANSWER_CHARS,
  MAX_DEPENDENCY_CONTEXT_CHARS,
  MAX_WORKFLOW_TIMEOUT_MS,
  isSystemJobId,
  WORKFLOW_ROOT,
} from "./config.mjs";
import { decideConcurrency } from "./choices.mjs";
import { EVIDENCE_CONTRACT, gradeJob } from "./evidence.mjs";
import { cancelJob, readJob, readJobLive, startJob } from "./jobs.mjs";
import {
  PlanError,
  assertPlanStillContained,
  feasibleBatch,
  normaliseAllowedPaths,
  parsePlan,
  taskSummary,
  unreachable,
  validatePlan,
} from "./plan.mjs";

/**
 * Parent workflow controller.
 *
 * One `dsh_delegate` call owns a whole delivery: it starts a read-only planner
 * worker, validates the returned plan in code, then repeatedly chooses a safe
 * batch of tasks, starts one worker per task, and releases dependent tasks only
 * when their dependencies produced valid success evidence. The parent ends in
 * `awaiting_review` — it never claims the work is accepted, because acceptance
 * is the caller's job.
 *
 * Live workflows live in memory. A snapshot is written under WORKFLOW_ROOT so a
 * later `dsh_get` can report what happened, but a snapshot from a previous
 * process is never re-adopted as a running workflow: no process scanning, no
 * resumption, no queue.
 */

/** Live parent workflows owned by this process. */
const workflows = new Map();

/** Injected seams for offline testing. */
const deps = {
  startJob,
  cancelJob,
  readJob,
  decideConcurrency,
};

/** Replace one seam (tests only). */
export function __setWorkflowDeps(overrides) {
  Object.assign(deps, overrides);
}

function ensureRoot() {
  mkdirSync(WORKFLOW_ROOT, { recursive: true });
}

/**
 * Persist the compact parent snapshot.
 *
 * Artifacts (full plan, raw chooser responses, worker answers) go to a sibling
 * artifact file so the status snapshot stays small enough to read often.
 */
function persist(workflow) {
  try {
    ensureRoot();
    const snapshot = {
      job_id: workflow.job_id,
      kind: "workflow",
      status: workflow.status,
      phase: workflow.phase,
      task_request: workflow.request.task.slice(0, 2_000),
      cwd: workflow.request.cwd,
      mode: workflow.request.mode,
      allowed_paths: workflow.request.allowed_paths,
      timeout_ms: workflow.request.timeout_ms,
      created_at: workflow.created_at,
      deadline_at: workflow.deadline_at,
      ended_at: workflow.ended_at,
      error: workflow.error,
      plan_summary: workflow.plan === null ? null : planSummary(workflow.plan),
      children: (workflow.children ?? []).map(compactChild),
      decisions: workflow.decisions,
      // The full cancellation report is the record of what was signalled; the
      // bounded status read summarises it rather than keeping it in the snapshot
      // only. Persisted so the complete lists survive a later read of the file.
      cancel_report: workflow.cancel_report ?? null,
      counts: countOutcomes(workflow),
      artifact_path: workflow.artifact_path,
    };
    writeFileSync(join(WORKFLOW_ROOT, `${workflow.job_id}.json`), JSON.stringify(snapshot));
  } catch {
    // Persistence is best-effort; a full or read-only temp dir must not abort work.
  }
}

function appendArtifact(workflow, section, payload) {
  try {
    ensureRoot();
    const dir = join(WORKFLOW_ROOT, workflow.job_id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${section}.json`);
    writeFileSync(path, JSON.stringify(payload, null, 2));
    return path;
  } catch {
    return null;
  }
}

function planSummary(plan) {
  return {
    mode: plan.mode,
    cwd: plan.cwd,
    task_count: plan.tasks.length,
    tasks: plan.tasks.map((task) => ({
      id: task.id,
      task: task.task.slice(0, 300),
      read_paths: task.read_paths,
      write_paths: task.write_paths,
      depends_on: task.depends_on,
      acceptance: task.acceptance,
    })),
  };
}

function compactChild(child) {
  return {
    id: child.id,
    task_id: child.task_id,
    job_id: child.job_id,
    status: child.status,
    outcome: child.outcome,
    started_at: child.started_at,
    ended_at: child.ended_at,
    summary: child.summary,
    changed_files: child.changed_files,
    checks: child.checks,
    // Kept in full: the persisted evidence is the record the caller reviews, so
    // the artifact paths and unresolved issues a worker reported must survive
    // the compaction that the bounded status read performs elsewhere.
    artifacts: child.artifacts ?? [],
    issues: child.issues ?? [],
    reason: child.reason,
  };
}

function countOutcomes(workflow) {
  const counts = { total: 0, done: 0, failed: 0, blocked: 0, running: 0, pending: 0 };
  for (const child of workflow.children ?? []) {
    counts.total += 1;
    if (child.status === "running") counts.running += 1;
    else if (child.status === "pending") counts.pending += 1;
    else if (child.status === "done") counts.done += 1;
    else if (child.status === "blocked") counts.blocked += 1;
    else counts.failed += 1;
  }
  return counts;
}

/**
 * Read a parent workflow: the live object when this process owns it, otherwise
 * the on-disk snapshot. A snapshot is returned with a flag making it explicit
 * that no controller is attached, so a caller cannot mistake it for something
 * that can still be waited on or cancelled.
 *
 * The id is shape-checked before it is joined into a path, for the same reason
 * as `readJob`: the snapshot path is built from caller input, and only ids this
 * bridge minted with `randomUUID()` are ever written there.
 */
export function readWorkflow(workflowId) {
  if (!isSystemJobId(workflowId)) return { workflow: undefined, live: false };
  const live = workflows.get(workflowId);
  if (live !== undefined) return { workflow: live, live: true };
  try {
    const raw = readFileSync(join(WORKFLOW_ROOT, `${workflowId}.json`), "utf8");
    return { workflow: JSON.parse(raw), live: false };
  } catch {
    return { workflow: undefined, live: false };
  }
}

/** List persisted workflows newest-first, without touching worker snapshots. */
export function listWorkflows() {
  const found = [];
  try {
    ensureRoot();
    for (const name of readdirSync(WORKFLOW_ROOT)) {
      if (!name.endsWith(".json")) continue;
      try {
        found.push(JSON.parse(readFileSync(join(WORKFLOW_ROOT, name), "utf8")));
      } catch {
        // Skip an unreadable snapshot instead of failing the listing.
      }
    }
  } catch {
    // Fall through to in-memory entries.
  }
  for (const workflow of workflows.values()) {
    if (!found.some((entry) => entry.job_id === workflow.job_id)) {
      found.push(persistShape(workflow));
    }
  }
  return found.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Snapshot-shaped view of a live workflow, for listings. */
function persistShape(workflow) {
  return {
    job_id: workflow.job_id,
    kind: "workflow",
    status: workflow.status,
    phase: workflow.phase,
    task_request: workflow.request.task.slice(0, 2_000),
    cwd: workflow.request.cwd,
    created_at: workflow.created_at,
    ended_at: workflow.ended_at,
    counts: countOutcomes(workflow),
  };
}

/** The planner prompt. Read-only investigation, strict JSON out, no recursion. */
function planningPrompt(request) {
  return [
    "You are a planning worker inside an automated coding bridge. You produce a plan; you do not execute it.",
    "",
    "## Overall objective",
    request.task.trim(),
    "",
    "## Working directory",
    request.cwd,
    "",
    "## Mode",
    request.mode === "read-only"
      ? "The overall objective is READ-ONLY. Every task you emit must declare write_paths as an empty array."
      : "The overall objective may modify files.",
    "",
    "## Allowed paths",
    request.allowed_paths.length > 0
      ? request.allowed_paths.map((path) => `- ${path}`).join("\n")
      : "- . (the whole working directory)",
    "Every path you declare must be relative to the working directory and inside the allowed paths above.",
    "",
    "## Hard rules",
    "- Investigate the codebase read-only. Do not modify, create, or delete any file.",
    "- Do NOT delegate, spawn subagents, or start other workers. You are the only worker.",
    "- Split the objective into as FEW tasks as possible. Prefer one task when one task suffices.",
    "- Each task must be self-contained: a different worker with no memory of this conversation must be able to complete it from its text plus the repository.",
    "- Each task must state its own boundaries and how the worker should verify it.",
    "- Declare read_paths and write_paths per task. Two tasks that might run at the same time must not declare overlapping paths unless both only read them.",
    "",
    "## Output",
    "Your final message must be a single JSON object and nothing else:",
    "{",
    '  "tasks": [',
    "    {",
    '      "id": "short-stable-id",',
    '      "task": "the complete, self-contained instruction for one worker",',
    '      "read_paths": ["relative/dir/or/file"],',
    '      "write_paths": ["relative/dir/or/file"],',
    '      "depends_on": ["id-of-another-task"],',
    '      "acceptance": "how the worker should prove it is done"',
    "    }",
    "  ]",
    "}",
    "Emit no prose outside the JSON object.",
  ].join("\n");
}

/** The execution prompt for one task worker. */
function executionPrompt({ request, plan, task, answers }) {
  const lines = [
    "You are one worker inside an automated coding bridge. Complete exactly the task below.",
    "",
    "## Overall objective (context only; do not expand your scope)",
    request.task.trim(),
    "",
    "## Working directory",
    request.cwd,
    "",
    "## Mode",
    request.mode === "read-only"
      ? "READ-ONLY. Do not modify, create, or delete any file."
      : "You may modify files, but only inside your declared write paths below.",
    "",
    "## Your task id",
    task.id,
    "",
    "## Your task",
    task.task,
    "",
    "## Paths",
    `read_paths: ${task.read_paths.join(", ")}`,
    `write_paths: ${task.write_paths.length > 0 ? task.write_paths.join(", ") : "(none)"}`,
  ];
  if (request.allowed_paths.length > 0) {
    lines.push(`allowed_paths: ${request.allowed_paths.join(", ")}`);
  }
  if (task.acceptance !== null) {
    lines.push("", "## Acceptance", task.acceptance);
  }
  if (answers.length > 0) {
    lines.push("", "## Results from tasks you depend on");
    for (const answer of answers) {
      lines.push(`### ${answer.id}`, answer.summary);
      if (answer.changed_files.length > 0) {
        lines.push(`changed_files: ${answer.changed_files.join(", ")}`);
      }
      lines.push("");
    }
  }
  lines.push(
    "",
    "## Hard rules",
    "- Do NOT delegate, spawn subagents, or start other workers. Complete the work yourself.",
    "- Do not touch paths outside your declared read_paths and write_paths.",
    "- Run the checks your acceptance criteria imply and record their real exit codes.",
    "",
    "## Required final message",
    EVIDENCE_CONTRACT,
  );
  return lines.join("\n");
}

/**
 * Start a parent workflow.
 *
 * Returns immediately with the parent job id; all phases run in the background
 * so the MCP call never blocks for the length of the delivery.
 */
export function startWorkflow({ task, cwd, mode, allowedPaths, timeoutMs, profile, dshBin }) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("task must be a non-empty string");
  }
  if (mode !== "read-only" && mode !== "workspace-write") {
    throw new Error('mode must be "read-only" or "workspace-write"');
  }
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error("cwd must be an explicit absolute directory path");
  }
  if (!isAbsolute(cwd)) {
    throw new Error(`cwd must be an absolute path, got "${cwd}"`);
  }
  if (cwd.includes("\0")) {
    throw new Error("cwd contains a NUL byte");
  }
  let cwdCanonical;
  try {
    const stats = statSync(cwd);
    if (!stats.isDirectory()) throw new Error("not a directory");
    cwdCanonical = realpathSync(cwd);
  } catch (error) {
    throw new Error(`cwd is not a usable directory: ${cwd} (${error.message})`);
  }
  let allowed_paths;
  try {
    allowed_paths = normaliseAllowedPaths(allowedPaths);
  } catch (error) {
    throw new Error(`allowed_paths is invalid: ${error.message}`);
  }
  const requested = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_WORKFLOW_TIMEOUT_MS;
  const bounded = Math.min(requested, MAX_WORKFLOW_TIMEOUT_MS);

  const workflowId = randomUUID();
  const workflow = {
    job_id: workflowId,
    status: "planning",
    phase: "planning",
    created_at: new Date().toISOString(),
    ended_at: null,
    deadline_at: Date.now() + bounded,
    error: null,
    request: {
      task,
      cwd: cwdCanonical,
      mode,
      allowed_paths,
      timeout_ms: bounded,
      profile,
      dsh_bin: dshBin,
    },
    plan: null,
    plan_job_id: null,
    planner_job_id: null,
    children: [],
    decisions: [],
    cancelled: false,
    artifact_path: null,
    controller_alive: true,
    proc: undefined,
    timer: undefined,
  };
  workflows.set(workflowId, workflow);
  persist(workflow);

  runWorkflow(workflow).catch((error) => {
    settle(workflow, "failed", error?.message ?? String(error));
  });

  return workflow;
}

/** Mark a workflow settled and persist. */
function settle(workflow, status, error = null) {
  if (workflow.ended_at !== null) return;
  workflow.status = status;
  workflow.phase = status;
  workflow.ended_at = new Date().toISOString();
  workflow.error = error;
  workflow.controller_alive = false;
  if (workflow.timer !== undefined) clearTimeout(workflow.timer);
  if (workflow.deadline_timer !== undefined) {
    clearTimeout(workflow.deadline_timer);
    workflow.deadline_timer = undefined;
  }
  // A settled workflow has no judgment in flight; aborting is a no-op if none.
  try {
    workflow.abort_controller?.abort(new Error(`workflow settled as ${status}`));
  } catch {
    // Already aborted.
  }
  workflow.abort_controller = undefined;
  persist(workflow);
}

function remainingMs(workflow) {
  return workflow.deadline_at - Date.now();
}

/** Start one worker for a task, honouring the parent deadline. */
function startTaskWorker(workflow, task, answers) {
  const child = {
    id: randomUUID(),
    task_id: task.id,
    job_id: null,
    status: "running",
    outcome: null,
    started_at: new Date().toISOString(),
    ended_at: null,
    summary: "",
    changed_files: [],
    checks: [],
    reason: null,
    answer: "",
  };
  workflow.children.push(child);
  try {
    const job = deps.startJob({
      task: executionPrompt({ request: workflow.request, plan: workflow.plan, task, answers }),
      cwd: workflow.request.cwd,
      profile: workflow.request.profile,
      dshBin: workflow.request.dsh_bin,
      deadlineAt: workflow.deadline_at,
    });
    child.job_id = job.job_id;
    // The parent keeps only what it needs to cancel precisely: the worker job id.
    child.worker_job_id = job.job_id;
  } catch (error) {
    child.status = "failed";
    child.outcome = "failed";
    child.reason = `could not start worker: ${error.message}`;
    child.ended_at = new Date().toISOString();
  }
  persist(workflow);
  return child;
}

/** Await a worker job, bounded by the parent deadline and a poll interval. */
async function awaitWorker(workflow, child) {
  if (child.job_id === null) return;
  for (;;) {
    if (workflow.cancelled) return;
    const job = deps.readJob(child.job_id);
    if (job !== undefined && job.status !== "running") {
      const status = job.status;
      const answer = extractWorkerAnswer(job);
      const graded = gradeJob(job, { answer, status });
      child.status = graded.ok ? "done" : graded.outcome === "blocked" ? "blocked" : "failed";
      child.outcome = graded.outcome;
      child.reason = graded.reason;
      child.summary = graded.report?.summary ?? "";
      child.changed_files = graded.report?.changed_files ?? [];
      child.checks = graded.report?.checks ?? [];
      child.artifacts = graded.report?.artifacts ?? [];
      child.issues = graded.report?.issues ?? [];
      child.answer = String(answer ?? "").slice(0, MAX_ARTIFACT_ANSWER_CHARS);
      child.ended_at = new Date().toISOString();
      persist(workflow);
      return;
    }
    if (remainingMs(workflow) <= 0) {
      // The parent deadline is the hard stop. The worker job carries the same
      // deadline, so it is already being torn down; record the outcome here.
      child.status = "failed";
      child.outcome = "failed";
      child.reason = "workflow deadline expired while this task was running";
      child.ended_at = new Date().toISOString();
      persist(workflow);
      return;
    }
    await sleep(Math.min(250, Math.max(25, remainingMs(workflow))));
  }
}

function extractWorkerAnswer(job) {
  const stdout = String(job.stdout ?? "").trim();
  if (stdout === "") return "";
  const fenced = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/.exec(stdout);
  return fenced ? fenced[1].trim() : stdout;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Compact dependency results handed to a downstream worker. */
function dependencyAnswers(workflow, task) {
  const answers = [];
  for (const dependency of task.depends_on) {
    const child = workflow.children.find((entry) => entry.task_id === dependency);
    if (child === undefined || child.status !== "done") continue;
    answers.push({
      id: dependency,
      summary: (child.summary || child.answer || "").slice(0, MAX_DEPENDENCY_CONTEXT_CHARS),
      changed_files: child.changed_files ?? [],
    });
  }
  return answers;
}

/**
 * The workflow state handed to TypeSafe.
 *
 * Deliberately small: the goal, the requested mode, and one compact entry per
 * candidate task. The repository and the logs are never uploaded.
 */
function chooserState(workflow, options) {
  return {
    objective: workflow.request.task.slice(0, 2_000),
    mode: workflow.request.mode,
    allowed_paths: workflow.request.allowed_paths,
    remaining_ms: Math.max(0, remainingMs(workflow)),
    completed: workflow.children
      .filter((child) => child.status === "done")
      .map((child) => child.task_id),
    failed: workflow.children
      .filter((child) => child.status === "failed" || child.status === "blocked")
      .map((child) => child.task_id),
    candidate_levels: options.map((batch) => ({
      level: batch.length,
      tasks: batch.map((task) => taskSummary(task, workflow.plan)),
    })),
  };
}

/**
 * Drive one workflow to `awaiting_review`.
 *
 * Plan -> validate -> schedule in batches until nothing is ready, then settle.
 * Cancellation and the deadline are re-checked before every worker start, so a
 * cancelled or expired workflow can never launch another process.
 */
async function runWorkflow(workflow) {
  const planJob = startPlanner(workflow);
  if (planJob === null) return;

  const finishedPlan = await awaitPlanner(workflow, planJob);
  if (finishedPlan === null) return;
  // Planning can take minutes; a cancel or an expired deadline that landed while
  // it ran must not be overwritten by a "finished" planner answer.
  if (workflow.cancelled) {
    settle(workflow, "cancelled", "cancelled by request");
    return;
  }
  if (remainingMs(workflow) <= 0) {
    settle(workflow, "timed-out", "workflow deadline expired while planning");
    return;
  }

  let rawPlan;
  try {
    rawPlan = parsePlan(finishedPlan);
  } catch (error) {
    settle(
      workflow,
      "failed",
      error instanceof PlanError ? `planner output rejected: ${error.message}` : String(error),
    );
    return;
  }

  let plan;
  try {
    plan = validatePlan(rawPlan, {
      cwd: workflow.request.cwd,
      cwdCanonical: workflow.request.cwd,
      mode: workflow.request.mode,
      allowedPaths: workflow.request.allowed_paths,
    });
  } catch (error) {
    // An invalid plan is a hard failure. It is never repaired and never run.
    appendArtifact(workflow, "rejected-plan", {
      error: error.message,
      detail: error.detail ?? null,
      raw_plan: rawPlan,
    });
    settle(workflow, "failed", `plan rejected: ${error.message}`);
    return;
  }
  workflow.plan = plan;
  workflow.artifact_path = appendArtifact(workflow, "plan", planSummary(plan));
  persist(workflow);

  const done = new Set();
  const failed = new Set();
  const started = new Set();
  workflow.status = "executing";
  workflow.phase = "executing";
  persist(workflow);

  for (;;) {
    if (workflow.cancelled) {
      settle(workflow, "cancelled", "cancelled by request");
      return;
    }
    if (remainingMs(workflow) <= 0) {
      settle(workflow, "timed-out", "workflow deadline expired");
      return;
    }

    const state = { done, failed, started };
    const { compatible, options } = feasibleBatch(plan, state);
    if (compatible.length === 0) {
      // Nothing ready. Either everything settled, or the rest is unreachable.
      const blockedTasks = unreachable(plan, state);
      for (const task of plan.tasks) {
        if (blockedTasks.has(task.id) && !failed.has(task.id)) {
          failed.add(task.id);
          workflow.children.push({
            id: randomUUID(),
            task_id: task.id,
            job_id: null,
            status: "blocked",
            outcome: "blocked",
            started_at: null,
            ended_at: new Date().toISOString(),
            summary: "",
            changed_files: [],
            checks: [],
            reason: "a dependency failed, so this task was never started",
            answer: "",
          });
        }
      }
      break;
    }

    const decided = await choose(workflow, options);

    // The judgment can take seconds, so a cancel or an expired deadline may have
    // landed while it ran. Re-check first: a decision the workflow never acted
    // on must not be recorded as if it had been executed. It is recorded as
    // `discarded` instead, so the evidence shows the judgment happened and was
    // deliberately not dispatched.
    //
    // The record is persisted here rather than left to the next loop turn,
    // because a cancel settles and persists the workflow *before* an in-flight
    // judgment resolves: by the time this line runs the workflow may already be
    // terminal. `settle` is a no-op once `ended_at` is set, so this path
    // persists the snapshot itself — otherwise the record would live only in
    // memory and never reach the snapshot the caller reads.
    if (workflow.cancelled) {
      workflow.decisions.push({ ...decided.record, discarded: true, discarded_reason: "cancelled before dispatch" });
      persist(workflow);
      // A cancelled workflow can never dispatch again, so when it has already
      // settled there is nothing left to re-check: leave the loop instead of
      // spinning on the same terminal state.
      if (workflow.ended_at !== null) return;
      continue;
    }
    if (remainingMs(workflow) <= 0) {
      workflow.decisions.push({
        ...decided.record,
        discarded: true,
        discarded_reason: "workflow deadline expired before dispatch",
      });
      persist(workflow);
      // Same reasoning as the cancel path above.
      if (workflow.ended_at !== null) return;
      continue;
    }
    workflow.decisions.push(decided.record);

    // The filesystem may have changed since planning. Re-prove that every path
    // still resolves inside the cwd before any worker is dispatched.
    try {
      assertPlanStillContained(plan);
    } catch (error) {
      appendArtifact(workflow, "rejected-plan", {
        error: error.message,
        stage: "pre-dispatch",
        raw_plan: rawPlan,
      });
      settle(workflow, "failed", `plan rejected before dispatch: ${error.message}`);
      return;
    }

    const batch = options[Math.max(0, Math.min(options.length - 1, decided.count - 1))];
    // A chosen batch must itself be compatible; options are built that way, but
    // this guards the invariant if the chooser ever returns something odd.
    const finalBatch = compatibleBatchOrFirst(batch, compatible);

    const children = [];
    for (const task of finalBatch) {
      if (workflow.cancelled || remainingMs(workflow) <= 0) break;
      started.add(task.id);
      children.push(startTaskWorker(workflow, task, dependencyAnswers(workflow, task)));
    }
    if (children.length === 0) break;

    persist(workflow);
    await Promise.all(children.map((child) => awaitWorker(workflow, child)));

    for (const child of children) {
      if (child.status === "done") done.add(child.task_id);
      else {
        failed.add(child.task_id);
      }
    }
    persist(workflow);
  }

  const counts = countOutcomes(workflow);
  workflow.phase = "awaiting_review";
  workflow.status = "awaiting_review";
  workflow.ended_at = new Date().toISOString();
  workflow.controller_alive = false;
  workflow.result_counts = counts;
  // The parent never asserts acceptance: the caller reviews the evidence.
  appendArtifact(workflow, "evidence", {
    counts,
    children: workflow.children.map(compactChild),
  });
  persist(workflow);
}

function compatibleBatchOrFirst(batch, compatible) {
  for (const task of batch) {
    if (!compatible.some((entry) => entry.id === task.id)) return [compatible[0]];
  }
  return batch;
}

/** Start the read-only planning worker. */
function startPlanner(workflow) {
  if (workflow.cancelled) {
    settle(workflow, "cancelled", "cancelled by request");
    return null;
  }
  if (remainingMs(workflow) <= 0) {
    settle(workflow, "timed-out", "workflow deadline expired before planning");
    return null;
  }
  const planningTimeout = Math.min(
    DEFAULT_PLANNING_TIMEOUT_MS,
    Math.max(1, remainingMs(workflow)),
  );
  try {
    const job = deps.startJob({
      task: planningPrompt(workflow.request),
      cwd: workflow.request.cwd,
      profile: workflow.request.profile,
      dshBin: workflow.request.dsh_bin,
      timeoutMs: planningTimeout,
      deadlineAt: workflow.deadline_at,
    });
    workflow.plan_job_id = job.job_id;
    workflow.planner_job_id = job.job_id;
    persist(workflow);
    return job.job_id;
  } catch (error) {
    settle(workflow, "failed", `could not start planner: ${error.message}`);
    return null;
  }
}

/** Await the planner, respecting the parent deadline and cancellation. */
async function awaitPlanner(workflow, plannerJobId) {
  for (;;) {
    if (workflow.cancelled) {
      settle(workflow, "cancelled", "cancelled by request");
      return null;
    }
    const job = deps.readJob(plannerJobId);
    if (job !== undefined && job.status !== "running") {
      if (job.status !== "done") {
        settle(workflow, "failed", `planner ended as ${job.status}`);
        return null;
      }
      const answer = extractWorkerAnswer(job);
      appendArtifact(workflow, "planning-answer", {
        job_id: plannerJobId,
        status: job.status,
        answer: String(answer ?? "").slice(0, MAX_ARTIFACT_ANSWER_CHARS),
      });
      workflow.status = "judging";
      workflow.phase = "judging";
      persist(workflow);
      return answer;
    }
    if (remainingMs(workflow) <= 0) {
      settle(workflow, "timed-out", "workflow deadline expired while planning");
      return null;
    }
    await sleep(Math.min(250, Math.max(25, remainingMs(workflow))));
  }
}

/**
 * One bounded concurrency judgment.
 *
 * The decision record always names its source, so a serial fallback is visible
 * in the workflow artifact rather than looking like an ordinary choice.
 *
 * The judgment is bound to the parent's cancellation flag and deadline through
 * an AbortSignal built here and mirrored on the workflow. A cancel or an expired
 * deadline therefore ends an in-flight TypeSafe call immediately rather than
 * waiting for the full HTTP timeout, and the caller re-checks both afterwards
 * before anything is dispatched.
 */
async function choose(workflow, options) {
  const state = chooserState(workflow, options);
  const deadlineAt = workflow.deadline_at;
  const budget = Math.max(1, deadlineAt - Date.now());
  const deadlineSignal =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(budget)
      : new AbortController().signal;

  let controller;
  if (!workflow.cancelled) {
    controller = new AbortController();
    workflow.abort_controller = controller;
    if (remainsWithinBudget(deadlineAt)) {
      workflow.deadline_timer = setTimeout(() => {
        if (workflow.ended_at === null || workflow.cancelled) {
          controller.abort(new Error("workflow deadline expired during judgment"));
        }
      }, budget);
      workflow.deadline_timer?.unref?.();
    }
  }

  const signal =
    controller === undefined
      ? deadlineSignal
      : typeof AbortSignal.any === "function"
        ? AbortSignal.any([controller.signal, deadlineSignal])
        : controller.signal;

  let decision;
  try {
    decision = await deps.decideConcurrency({ options, state, signal });
  } finally {
    workflow.abort_controller = undefined;
    if (workflow.deadline_timer !== undefined) {
      clearTimeout(workflow.deadline_timer);
      workflow.deadline_timer = undefined;
    }
  }

  const record = {
    at: new Date().toISOString(),
    source: decision.source,
    count: decision.count,
    reason: decision.reason ?? null,
    confidence: decision.confidence ?? null,
    model: typeof decision.model === "string" ? decision.model : null,
    candidate_sizes: options.map((batch) => batch.length),
    candidate_ids: options.map((batch) => batch.map((task) => task.id)),
  };
  return { count: decision.count, record, decision };
}

/** True while the workflow's absolute deadline is still in the future. */
function remainsWithinBudget(deadlineAt) {
  return deadlineAt - Date.now() > 0;
}

/**
 * Cancel a parent workflow.
 *
 * Stops any further dispatch immediately, then requests cancellation of every
 * worker this parent started that is still live in this process — the planner
 * while it is still planning, and every task worker still running. Reports
 * precisely which cancellations were requested and which were not confirmed —
 * it does not claim to have killed grandchildren.
 */
export function cancelWorkflow(workflowId) {
  const workflow = workflows.get(workflowId);
  if (workflow === undefined) {
    const { workflow: snapshot, live } = readWorkflow(workflowId);
    if (snapshot === undefined) return { cancelled: false, reason: "unknown workflow" };
    if (!live) {
      return {
        cancelled: false,
        reason:
          "this workflow is a snapshot from a previous process; no controller is attached, so it cannot be cancelled",
        status: snapshot.status,
      };
    }
    return { cancelled: false, reason: `workflow is already ${snapshot.status}` };
  }
  if (workflow.ended_at !== null) {
    return { cancelled: false, reason: `workflow is already ${workflow.status}` };
  }

  workflow.cancelled = true;
  // End any in-flight TypeSafe judgment now rather than at the HTTP timeout.
  try {
    workflow.abort_controller?.abort(new Error("workflow cancelled"));
  } catch {
    // Aborting an already-finished judgment is a no-op.
  }
  const requested = [];
  const notConfirmed = [];
  const cancelTarget = (taskId, jobId) => {
    if (jobId === null || jobId === undefined) return;
    const liveJob = readJobLive(jobId);
    if (liveJob === undefined) {
      notConfirmed.push({ task_id: taskId, job_id: jobId, reason: "worker not live in this process" });
      return;
    }
    const result = deps.cancelJob(jobId);
    if (result.cancelled === true) {
      requested.push({ task_id: taskId, job_id: jobId, pid: result.pid ?? null });
    } else {
      notConfirmed.push({ task_id: taskId, job_id: jobId, reason: result.reason });
    }
  };
  for (const child of workflow.children) {
    if (child.status !== "running") continue;
    cancelTarget(child.task_id, child.job_id);
  }
  // The planner is a worker this parent started too. While it is still live it
  // is cancelled through the same precise-id path, with the same honest report,
  // rather than being left running until its own timeout.
  const plannerJobId = workflow.plan_job_id ?? workflow.planner_job_id ?? null;
  if (plannerJobId !== null) {
    const plannerLive = readJobLive(plannerJobId);
    if (plannerLive !== undefined && plannerLive.status === "running") {
      cancelTarget(plannerLive.task_id ?? "planner", plannerJobId);
    }
  }
  workflow.cancel_report = { requested, not_confirmed: notConfirmed };
  settle(workflow, "cancelled", "cancelled by request");
  persist(workflow);
  return {
    cancelled: true,
    status: "cancelled",
    children_cancel_requested: requested,
    children_not_confirmed: notConfirmed,
    note:
      "Only worker processes started by this parent were signalled. " +
      "Requests are not confirmation of exit, and processes those workers started themselves are not signalled.",
  };
}

/**
 * Default shape of a workflow status read.
 *
 * A workflow can have hundreds of children, and the caller here is an agent with
 * a context budget, not a log viewer. The default read is therefore bounded in
 * four dimensions — children, checks and changed files per child, and the recent
 * scheduling history — while every omission is reported as an explicit count.
 * The complete evidence is never lost: it stays in the artifact files, whose
 * directory is always returned.
 *
 * Every bound is sized so that an ordinary read fits without further work; the
 * encoded payload is then measured, and a read that is still above
 * `MAX_CHARS` — a child with every field at its maximum, say — is shrunk from
 * the least interesting end until it fits. These are explainable constants, not
 * a pagination framework.
 */
export const STATUS_LIMITS = {
  /** Default maximum characters in a status payload. */
  MAX_CHARS: 12_000,
  /** Child summaries returned by default, worst case about 1.1 KB each. */
  CHILDREN: 8,  /** Checks per child by default (a failure is always kept, inside the scan). */
  CHECKS_PER_CHILD: 4,
  /** How many checks are scanned when looking for a failing one. */
  CHECK_SCAN: 60,
  /** Changed files per child by default. */
  CHANGED_FILES_PER_CHILD: 6,
  /** Most recent scheduling decisions by default. */
  DECISIONS: 6,
  /** Cancellation entries listed per list by default; the rest are counted. */
  CANCEL_ENTRIES: 3,
  /** String fields longer than this are truncated in the default read. */
  FIELD_CHARS: 160,
};

/** Truncate one string field, saying so rather than silently cutting it. */
function clip(value, limit) {
  if (typeof value !== "string") return value ?? null;
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

/**
 * Order children for the default read: work that needs attention first, then
 * running, then the rest. A failure must never be pushed out of the summary by
 * a long tail of successful tasks, so the truncation above only ever drops the
 * least interesting entries.
 */
function childRank(child) {
  if (child.status === "failed") return 0;
  if (child.status === "blocked") return 1;
  if (child.status === "running") return 2;
  if (child.status === "pending") return 3;
  return 4;
}

function compactCheck(check = {}, { detail = false } = {}) {
  return {
    command: detail ? (check.command ?? null) : clip(check.command, STATUS_LIMITS.FIELD_CHARS),
    exit_code: check.exit_code ?? null,
  };
}

/**
 * A summary of one worker's evidence.
 *
 * Bounded by default: every long string is clipped and every list is capped, so
 * a child whose every field is at its maximum still fits the per-child budget.
 *
 * With `detail` the values are returned exactly as recorded — full reason, full
 * summary, every check and every changed file, nothing clipped and nothing
 * dropped. The complete evidence is what the caller asked for, so this path
 * carries no per-field bound and no omission counts.
 *
 * Checks are scanned for the first non-zero exit code and that one is always
 * included, so trimming `checks` can never hide the failing command.
 */
function summariseChild(child, { detail }) {
  const checks = Array.isArray(child.checks) ? child.checks : [];
  const changedFiles = Array.isArray(child.changed_files) ? child.changed_files : [];
  const out = {
    task_id: child.task_id,
    job_id: child.job_id ?? null,
    status: child.status,
    outcome: child.outcome ?? null,
    reason: detail ? (child.reason ?? null) : clip(child.reason, STATUS_LIMITS.FIELD_CHARS),
    summary: detail
      ? (typeof child.summary === "string" ? child.summary : "")
      : clip(typeof child.summary === "string" ? child.summary : "", STATUS_LIMITS.FIELD_CHARS),
  };
  const shownChecks = detail ? checks : pickChecks(checks);
  out.checks = shownChecks.map((check) => compactCheck(check, { detail }));
  if (!detail && shownChecks.length < checks.length) {
    out.checks_omitted = checks.length - shownChecks.length;
  }
  out.changed_files = detail
    ? changedFiles.slice()
    : changedFiles.slice(0, STATUS_LIMITS.CHANGED_FILES_PER_CHILD).map((path) => clip(path, STATUS_LIMITS.FIELD_CHARS));
  if (!detail && changedFiles.length > out.changed_files.length) {
    out.changed_files_omitted = changedFiles.length - out.changed_files.length;
  }
  // Artifact paths and unresolved issues are part of the evidence, not the
  // transcript: the detail view always carries them in full, and the bounded
  // default view names their count rather than dropping them silently.
  const artifacts = Array.isArray(child.artifacts) ? child.artifacts : [];
  const issues = Array.isArray(child.issues) ? child.issues : [];
  if (detail) {
    out.artifacts = artifacts.slice();
    out.issues = issues.slice();
  } else {
    if (artifacts.length > 0) out.artifact_count = artifacts.length;
    if (issues.length > 0) {
      out.issues = issues
        .slice(0, STATUS_LIMITS.CHECKS_PER_CHILD)
        .map((issue) => clip(typeof issue === "string" ? issue : JSON.stringify(issue), STATUS_LIMITS.FIELD_CHARS));
      if (issues.length > out.issues.length) out.issues_omitted = issues.length - out.issues.length;
    }
  }
  return out;
}

/** Keep the failing check plus the leading successes, bounded either way. */
function pickChecks(checks) {
  const scanned = checks.slice(0, STATUS_LIMITS.CHECK_SCAN);
  const failing = scanned.filter((check) => check?.exit_code !== 0 && check?.exit_code !== null);
  const passing = scanned.filter((check) => check?.exit_code === 0 || check?.exit_code === null);
  const kept = [];
  for (const check of failing.slice(0, STATUS_LIMITS.CHECKS_PER_CHILD)) kept.push(check);
  for (const check of passing) {
    if (kept.length >= STATUS_LIMITS.CHECKS_PER_CHILD) break;
    kept.push(check);
  }
  return kept.slice(0, STATUS_LIMITS.CHECKS_PER_CHILD);
}

/**
 * Compact status for a parent workflow.
 *
 * Default output is counts, phases, child job ids and bounded per-task evidence
 * — never the full worker transcripts, which stay in the artifact. Failures and
 * blocked tasks are presented first, and everything trimmed is reported as a
 * count plus the artifact directory that still holds it in full. If the bounded
 * read is somehow still over `STATUS_LIMITS.MAX_CHARS`, the least interesting
 * trailing children and then the oldest scheduling decisions are dropped until
 * it fits, and those drops are counted in the same omission fields.
 *
 * `includeDetail: true` returns the unbounded view (full checks, full changed
 * files, every scheduling decision and the plan) for a caller that really wants
 * it.
 */
export function workflowStatus(workflow, { live, includeDetail = false } = {}) {
  const artifactDir = workflow.artifact_path
    ? join(WORKFLOW_ROOT, workflow.job_id)
    : null;

  const out = {
    job_id: workflow.job_id,
    kind: "workflow",
    status: workflow.status,
    phase: workflow.phase,
    cwd: workflow.request?.cwd ?? workflow.cwd,
    mode: workflow.request?.mode ?? workflow.mode,
    created_at: workflow.created_at,
    ended_at: workflow.ended_at,
    tool: "dsh_delegate",
  };
  if (!live) {
    out.controller_alive = false;
    out.note =
      "Snapshot from an earlier process. No controller is attached, so this workflow " +
      "cannot be resumed, waited on, or cancelled; its final phase is historical only.";
  } else {
    out.controller_alive = true;
    out.deadline_at = new Date(workflow.deadline_at).toISOString();
    out.remaining_ms = Math.max(0, workflow.deadline_at - Date.now());
  }
  if (workflow.error) out.error = clip(workflow.error, STATUS_LIMITS.FIELD_CHARS);
  if (workflow.plan_job_id ?? workflow.planner_job_id) {
    out.planner_job_id = workflow.plan_job_id ?? workflow.planner_job_id;
  }
  if (workflow.plan !== null && workflow.plan !== undefined) {
    out.task_count = workflow.plan.tasks.length;
  }
  out.counts = workflow.result_counts ?? countOutcomes(workflow);

  if (includeDetail) {
    const children = workflow.children ?? [];
    const decisions = Array.isArray(workflow.decisions) ? workflow.decisions : [];
    out.children = children.map((child = {}) => summariseChild(child, { detail: true }));
    if (decisions.length > 0) {
      out.scheduling = decisions.map(schedulingEntry);
    }
    if (workflow.cancel_report) out.cancel_report = workflow.cancel_report;
    out.decisions = decisions;
    out.scheduling_recent = decisions.length;
    if (workflow.error) out.error = workflow.error;
    if (workflow.plan) out.plan = planSummary(workflow.plan);
    // Always present: the full, untrimmed evidence is on disk in this directory.
    if (artifactDir !== null) out.artifact_dir = artifactDir;
    // Statuses derived from a raw worker job are normalised for the caller.
    if (workflow.status === "running") out.status = "executing";
    return out;
  }

  // The bounded default read. It is built once and then shrunk only if the
  // encoded payload is still above the cap, so the documented worst case stays
  // an observable bound rather than an assumption about the constants.
  const children = workflow.children ?? [];
  const decisions = Array.isArray(workflow.decisions) ? workflow.decisions : [];
  const available = children.length;
  // Failure-first ordering makes the tail of this list the least interesting
  // work, which is what lets the shrink step drop only from the back.
  const ordered = [...children].sort((a, b) => childRank(a) - childRank(b));
  let shownChildren = Math.min(STATUS_LIMITS.CHILDREN, available);
  let shownDecisions = Math.min(STATUS_LIMITS.DECISIONS, decisions.length);

  for (;;) {
    out.children = ordered
      .slice(0, shownChildren)
      .map((child = {}) => summariseChild(child, { detail: false }));
    const omittedChildren = available - shownChildren;
    if (omittedChildren > 0) out.children_omitted = omittedChildren;
    else delete out.children_omitted;
    const shownScheduling = shownDecisions > 0 ? decisions.slice(-shownDecisions) : [];
    if (shownScheduling.length > 0) out.scheduling = shownScheduling.map(schedulingEntry);
    else delete out.scheduling;
    const omittedDecisions = decisions.length - shownDecisions;
    if (omittedDecisions > 0) out.scheduling_omitted = omittedDecisions;
    else delete out.scheduling_omitted;
    if (workflow.cancel_report) out.cancel_report = summariseCancelReport(workflow.cancel_report);
    // Always present: the full, untrimmed evidence is on disk in this directory.
    if (artifactDir !== null) out.artifact_dir = artifactDir;
    if (out.children_omitted || out.scheduling_omitted) {
      out.note_detail =
        `Summarised: ${children.length} children and ${decisions.length} scheduling decisions on disk. ` +
        "Pass include_logs=true for the unbounded view, or read the artifact files.";
    }
    // Failures and blocked children sit at the front and are never dropped, so
    // each step strictly shrinks the payload and the loop always terminates.
    if (JSON.stringify(out).length <= STATUS_LIMITS.MAX_CHARS) break;
    if (shownChildren > 0) shownChildren -= 1;
    else if (shownDecisions > 0) shownDecisions -= 1;
    else break;
  }
  // Statuses derived from a raw worker job are normalised for the caller.
  if (workflow.status === "running") out.status = "executing";
  return out;
}

/** One scheduling decision, clipped for the default read. */
function schedulingEntry(decision = {}) {
  return {
    source: decision.source ?? null,
    count: decision.count ?? null,
    reason: clip(decision.reason, STATUS_LIMITS.FIELD_CHARS),
  };
}

/** One cancellation entry, clipped for the default read. */
function cancelEntry(entry = {}) {
  return {
    task_id: entry.task_id ?? null,
    job_id: entry.job_id ?? null,
    reason: clip(entry.reason, STATUS_LIMITS.FIELD_CHARS),
    pid: entry.pid ?? null,
  };
}

/**
 * Bounded view of a cancellation report.
 *
 * Cancelling a workflow with hundreds of children produces one entry per job in
 * two lists. Returned verbatim that is unbounded — and it is what the shrink
 * loop above cannot touch, because it is not a child or a decision — so the
 * default read keeps a few representative entries per list and reports the rest
 * as counts. The full report stays in the snapshot and in the artifact, and
 * `includeDetail: true` still returns it entry for entry.
 */
function summariseCancelReport(report = {}) {
  const requested = Array.isArray(report.requested) ? report.requested : [];
  const notConfirmed = Array.isArray(report.not_confirmed) ? report.not_confirmed : [];
  const out = { requested_count: requested.length, not_confirmed_count: notConfirmed.length };
  if (requested.length > 0) {
    out.requested = requested.slice(0, STATUS_LIMITS.CANCEL_ENTRIES).map(cancelEntry);
    if (requested.length > out.requested.length) {
      out.requested_omitted = requested.length - out.requested.length;
    }
  }
  if (notConfirmed.length > 0) {
    out.not_confirmed = notConfirmed.slice(0, STATUS_LIMITS.CANCEL_ENTRIES).map(cancelEntry);
    if (notConfirmed.length > out.not_confirmed.length) {
      out.not_confirmed_omitted = notConfirmed.length - out.not_confirmed.length;
    }
  }
  return out;
}

/** Status of one child worker job, compact by default. */
export function childStatus(workflow, taskId) {
  const child = (workflow.children ?? []).find(
    (entry) => entry.task_id === taskId || entry.job_id === taskId,
  );
  if (child === undefined) return undefined;
  const job = child.job_id === null ? undefined : readJob(child.job_id);
  return {
    task_id: child.task_id,
    job_id: child.job_id,
    status: child.status,
    outcome: child.outcome,
    reason: child.reason,
    worker_status: job?.status ?? null,
  };
}

/** Wait until a workflow settles, bounded by the caller's window. */
export async function waitWorkflow(workflowId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  const { live } = readWorkflow(workflowId);
  if (!live) return { settled: false, reason: "not live in this process" };
  for (;;) {
    const { workflow } = readWorkflow(workflowId);
    if (workflow === undefined) return { settled: false, reason: "unknown workflow" };
    if (workflow.ended_at !== null) return { settled: true, workflow };
    if (Date.now() >= deadline) return { settled: false, workflow };
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
  }
}

/** Worker-job view of a workflow's planner, for the legacy read tools. */
export function plannerJobId(workflow) {
  return workflow.plan_job_id ?? workflow.planner_job_id ?? null;
}
