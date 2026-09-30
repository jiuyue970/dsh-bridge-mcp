#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { credentialStatus } from "./choices.mjs";
import {
  DEFAULT_PROFILE,
  DEFAULT_PRUNE_AGE_DAYS,
  DEFAULT_TAIL_CHARS,
  DEFAULT_WAIT_WINDOW_MS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_ANSWER_CHARS,
  MAX_FOREGROUND_WAIT_CAP_MS,
  MAX_INLINE_WAIT_MS,
  MAX_TAIL_CHARS,
  MAX_WAIT_ANY_JOBS,
  MAX_WORKFLOW_TIMEOUT_MS,
  MIN_SHARED_ANSWER_CHARS,
  TIMEOUT_TIERS,
  WAIT_ANY_ANSWER_BUDGET_CHARS,
  WAIT_ANY_MAX_CHARS,
  WORKFLOW_TIMEOUT_TIERS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./config.mjs";
import { cancelJob, listJobs, pruneJobState, readJob, startJob, statusOf, waitJob } from "./jobs.mjs";
import { awaitAnySettlement } from "./settle.mjs";
import {
  cancelWorkflow,
  childStatus,
  listWorkflows,
  plannerJobId,
  pruneWorkflowState,
  readWorkflow,
  startWorkflow,
  waitWorkflow,
  workflowStatus,
} from "./workflow.mjs";

/**
 * MCP tool results are JSON text; never throw out of a handler.
 *
 * Compact, not indented: every result is re-sent with each later request of
 * the caller's conversation, and indentation measured 2.2% of the bridge's
 * replies while telling a model nothing it cannot parse without it.
 */
function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function fail(message) {
  return { isError: true, content: [{ type: "text", text: String(message) }] };
}

/**
 * Resolve a job id that may name either a worker job or a parent workflow.
 *
 * Parent workflows are the newer shape, so they are checked first; the fallback
 * keeps the six original tools working exactly as before.
 */
function requireJob(jobId) {
  const { workflow, live } = readWorkflow(jobId);
  if (workflow !== undefined) return { workflow, live };
  const job = readJob(jobId);
  if (job === undefined) {
    return { error: `unknown job_id "${jobId}": it is not running and no snapshot exists` };
  }
  return { job };
}

/**
 * Rows `dsh_list` returns per list. The state directory keeps every job until
 * it is pruned (1,310 on the measuring machine), so the list is bounded; the
 * counts still cover everything.
 */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

/**
 * The parent workflow entry point.
 *
 * One call owns the whole delivery: DSH plans, code validates the plan, TypeSafe
 * sizes each safe batch, and DSH workers execute. The parent ends in
 * `awaiting_review` with aggregated evidence; it never claims acceptance.
 */
server.registerTool(
  "dsh_delegate",
  {
    title: "Delegate a whole task to a managed DSH workflow",
    description:
      "Run one objective as a managed DeepSeek Harness workflow: one worker per task, ending in status awaiting_review " +
      "with per-task evidence. Returns a parent job_id at once; collect it with dsh_wait or dsh_wait_any. " +
      "awaiting_review is NOT acceptance, so check the evidence and the files yourself. " +
      "Prefer dsh_start for a single self-contained task.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe("The complete objective: every constraint, relevant path, and the definition of done."),
      cwd: z
        .string()
        .min(1)
        .describe("Absolute working directory. Every task path is validated relative to it."),
      mode: z
        .enum(["read-only", "workspace-write"])
        .describe(
          "read-only rejects any plan declaring a write path; workspace-write allows writes inside allowed_paths.",
        ),
      allowed_paths: z
        .array(z.string())
        .optional()
        .describe(
          'Paths the objective may touch, relative to cwd. Default ["."]; anything outside is rejected. ' +
            'With workspace-write, name a subpath rather than ".".',
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Total deadline in milliseconds for planning plus every task. Default ${DEFAULT_WORKFLOW_TIMEOUT_MS}, capped at ${MAX_WORKFLOW_TIMEOUT_MS}.`,
        ),
      tier: z
        .enum(["investigate", "edit", "build"])
        .optional()
        .describe(
          "Total deadline when timeout_ms is absent: investigate 20m, edit 1h, build 2h. timeout_ms wins if both are given.",
        ),
      profile: z
        .string()
        .optional()
        .describe(
          `DSH profile for each worker. Default "${DEFAULT_PROFILE}". ` +
            "mode does not narrow a profile's network tools.",
        ),
      decompose: z
        .boolean()
        .optional()
        .describe(
          "true adds an extra serial worker run to plan the split first. Default false; true only if the objective " +
            "genuinely needs concurrent tasks, since false is then still correct, just serial.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const workflow = startWorkflow({
        task: args.task,
        cwd: args.cwd,
        mode: args.mode,
        allowedPaths: args.allowed_paths,
        timeoutMs: args.timeout_ms ?? (args.tier ? WORKFLOW_TIMEOUT_TIERS[args.tier] : undefined),
        profile: args.profile,
        decompose: args.decompose,
      });
      const creds = credentialStatus();
      return ok({
        job_id: workflow.job_id,
        kind: "workflow",
        status: workflow.status,
        phase: workflow.phase,
        cwd: workflow.request.cwd,
        mode: workflow.request.mode,
        timeout_ms: workflow.request.timeout_ms,
        typesafe: creds,
        note: "Running. Collect it with dsh_wait. It ends in awaiting_review: a worker report you must verify yourself.",
      });
    } catch (error) {
      return fail(`dsh_delegate failed: ${error.message}`);
    }
  },
);

/**
 * Start a delegated DSH task.
 *
 * Async by design: the caller receives a job id immediately so the host agent
 * is never blocked for the duration of a long coding task.
 */
server.registerTool(
  "dsh_start",
  {
    title: "Start a DSH worker job",
    description:
      "Run one self-contained task on a DeepSeek Harness headless worker (bash, file read/write/search, skills) and " +
      "return a job_id at once; it reports only its final answer. Use dsh_delegate when an objective must be split " +
      "across workers instead. Do not start a second job for the same task while the first is still running.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "The complete, self-contained task; the worker sees only this text and its cwd, so include every constraint, path and expected outcome.",
        ),
      cwd: z
        .string()
        .optional()
        .describe("Absolute working directory for the worker. Defaults to the server's own cwd."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Deadline in ms; the worker is terminated when it expires. Default 30 minutes."),
      tier: z
        .enum(["investigate", "edit", "build"])
        .optional()
        .describe(
          "Deadline when timeout_ms is absent: investigate 5m, edit 15m, build 30m. timeout_ms wins if both are given.",
        ),
      wait_for_ms: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          `Hold the call open this long and return a finished result inline, saving a start-then-poll round trip. Max ${MAX_INLINE_WAIT_MS}. ` +
            "A job still running at the deadline is returned as a background job_id.",
        ),
      profile: z
        .string()
        .optional()
        .describe(`DSH profile to boot. Default "${DEFAULT_PROFILE}".`),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const job = startJob({
        task: args.task,
        cwd: args.cwd,
        timeoutMs: args.timeout_ms ?? (args.tier ? TIMEOUT_TIERS[args.tier] : undefined),
        profile: args.profile,
      });
      const inline = Math.min(args.wait_for_ms ?? 0, MAX_INLINE_WAIT_MS);
      if (inline > 0) {
        const startedAt = Date.now();
        const { settled, job: current } = await waitJob(job.job_id, inline);
        if (settled && current !== undefined) {
          const payload = statusOf(current);
          payload.waited_ms = Date.now() - startedAt;
          payload.returned_inline = true;
          return ok(payload);
        }
      }
      return ok({
        job_id: job.job_id,
        status: job.status,
        pid: job.pid ?? null,
        // The caller knows the directory it passed; only a defaulted one is news.
        ...(args.cwd === undefined ? { cwd: job.cwd } : {}),
        returned_inline: false,
        note: "Running. Collect it with dsh_wait, or dsh_wait_any for several.",
      });
    } catch (error) {
      return fail(`dsh_start failed: ${error.message}`);
    }
  },
);

/** Compact status read. Bulky fields stay opt-in to protect caller context. */
server.registerTool(
  "dsh_get",
  {
    title: "Read a DSH worker or workflow job",
    description:
      "Read compact status for a worker job or a dsh_delegate parent workflow: phase, counts, per-task evidence " +
      "summaries, child job ids. Bulk fields (stderr tail, full plan, transcripts) need include_logs. A read, not a " +
      "wait — dsh_wait and dsh_wait_any already return this on settlement, so use dsh_get to re-read a job you " +
      "stopped waiting on, or to recover a trimmed answer.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id returned by dsh_start or dsh_delegate."),
      include_logs: z
        .boolean()
        .optional()
        .describe(
          "Return the answer untrimmed, or a workflow's full decision and plan detail. Default false. A failure's " +
            "diagnostics are already included.",
        ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const found = requireJob(args.job_id);
    if (found.error !== undefined) return fail(found.error);
    if (found.workflow !== undefined) {
      return ok(workflowStatus(found.workflow, { live: found.live, includeDetail: args.include_logs === true }));
    }
    return ok(statusOf(found.job, { includeLogs: args.include_logs === true }));
  },
);

/**
 * Block for a bounded window.
 *
 * The window is capped server-side: an unbounded wait would let a caller hang
 * past any useful timeout, and DSH headless has no progress signal to poll.
 */
server.registerTool(
  "dsh_wait",
  {
    title: "Wait for a DSH worker or workflow job",
    description:
      "Wait up to max_wait_ms for a worker job or a dsh_delegate parent workflow to settle, then return its status. " +
      "This never cancels: a job still running after the window keeps running.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id returned by dsh_start or dsh_delegate."),
      max_wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Observation window in ms. Default ${DEFAULT_WAIT_WINDOW_MS}, max ${MAX_FOREGROUND_WAIT_CAP_MS}. A job still running at the deadline ` +
            "is waited on again with that default. Prefer long windows: each poll re-sends your whole conversation.",
        ),
      include_logs: z.boolean().optional().describe("Return the answer untrimmed when it settles. Default false."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const found = requireJob(args.job_id);
    if (found.error !== undefined) return fail(found.error);
    const window = Math.min(args.max_wait_ms ?? DEFAULT_WAIT_WINDOW_MS, MAX_FOREGROUND_WAIT_CAP_MS);
    const startedAt = Date.now();
    const deadline = startedAt + window;

    if (found.workflow !== undefined) {
      if (!found.live) {
        const payload = workflowStatus(found.workflow, { live: false });
        payload.waited_ms = 0;
        payload.note =
          "Snapshot from an earlier process; nothing to wait for. This workflow cannot be resumed or cancelled.";
        return ok(payload);
      }
      const outcome = await waitWorkflow(args.job_id, window);
      const { workflow } = readWorkflow(args.job_id);
      const payload = workflowStatus(workflow, { live: true, includeDetail: args.include_logs === true });
      payload.waited_ms = Math.min(window, Date.now() - startedAt);
      if (!outcome.settled) {
        payload.note = `Still running. Wait again on the same job with the ${DEFAULT_WAIT_WINDOW_MS} ms default window, which stays under the outer 300 s MCP tools/call limit; dsh_get would only return this same payload.`;
      }
      return ok(payload);
    }

    const { job: current } = await waitJob(args.job_id, Math.max(0, deadline - Date.now()));
    const payload = statusOf(current ?? found.job, { includeLogs: args.include_logs === true });
    payload.waited_ms = Math.min(window, Date.now() - startedAt);
    if ((current ?? found.job).status === "running") {
      payload.note = `Still running. Wait again on the same job with the ${DEFAULT_WAIT_WINDOW_MS} ms default window, which stays under the outer 300 s MCP tools/call limit; dsh_get would only return this same payload.`;
    }
    return ok(payload);
  },
);

/** Tail of the accumulated output, for a running or finished job. */
server.registerTool(
  "dsh_tail",
  {
    title: "Read a DSH worker output tail",
    description:
      "Return the last N characters of a worker's stderr and stdout. stderr_tail is the reasoning that streams, and the " +
      "only sign of progress while a job runs; stdout_tail is the answer, so use dsh_get with include_logs=true for a whole one.",
    inputSchema: {
      job_id: z
        .string()
        .min(1)
        .describe("A worker job_id, or a workflow job_id plus a child task_id to tail one worker."),
      chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Tail length per stream. Default ${DEFAULT_TAIL_CHARS}, capped at ${MAX_TAIL_CHARS}.`),
      task_id: z
        .string()
        .optional()
        .describe("For a dsh_delegate workflow: tail this child task instead of a worker job."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const found = requireJob(args.job_id);
    if (found.error !== undefined) return fail(found.error);
    const n = Math.min(args.chars ?? DEFAULT_TAIL_CHARS, MAX_TAIL_CHARS);
    const capped = (args.chars ?? 0) > MAX_TAIL_CHARS;
    /** Both tails of one worker job, saying so when the request was capped. */
    const tails = (job) => {
      const out = String(job.stdout ?? "");
      const err = String(job.stderr ?? "");
      return {
        stdout_tail: out.slice(-n),
        stderr_tail: err.slice(-n),
        stdout_chars: out.length,
        ...(capped ? { chars_capped: MAX_TAIL_CHARS } : {}),
      };
    };

    if (found.workflow !== undefined) {
      const workflow = found.workflow;
      if (args.task_id === undefined) {
        return ok({
          job_id: args.job_id,
          kind: "workflow",
          status: workflow.status,
          phase: workflow.phase,
          planner_job_id: plannerJobId(workflow),
          children: (workflow.children ?? []).map((child) => ({
            task_id: child.task_id,
            job_id: child.job_id,
            status: child.status,
          })),
          note: "Pass task_id to tail one child worker, or use its job_id directly.",
        });
      }
      const child = childStatus(workflow, args.task_id);
      if (child === undefined) return fail(`workflow has no task "${args.task_id}"`);
      if (child.job_id === null) {
        return ok({ ...child, stdout_tail: "", stderr_tail: "", stdout_chars: 0 });
      }
      const job = readJob(child.job_id);
      if (job === undefined) return fail(`child worker job "${child.job_id}" has no snapshot`);
      return ok({ job_id: child.job_id, task_id: child.task_id, status: job.status, ...tails(job) });
    }

    return ok({ job_id: found.job.job_id, status: found.job.status, ...tails(found.job) });
  },
);

/** Cancel a running job or parent workflow. */
server.registerTool(
  "dsh_cancel",
  {
    title: "Cancel a DSH worker job or workflow",
    description:
      "Request cancellation of a running worker job or dsh_delegate parent workflow, reporting which requests were " +
      "confirmed. Cancelling a workflow stops further tasks from starting and cancels the workers it already started. " +
      "Do not cancel because a job is quiet: a long task can run for minutes without output.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id returned by dsh_start or dsh_delegate."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    const { workflow, live } = readWorkflow(args.job_id);
    if (workflow !== undefined) {
      const result = cancelWorkflow(args.job_id);
      return ok({ job_id: args.job_id, kind: "workflow", ...result });
    }
    const job = readJob(args.job_id);
    if (job === undefined) return fail(`unknown job_id "${args.job_id}"`);
    if (job.status !== "running") return ok({ job_id: args.job_id, status: job.status, cancelled: false });
    const result = cancelJob(args.job_id);
    return ok({ job_id: args.job_id, ...result });
  },
);

/** List jobs and workflows, newest first. */
server.registerTool(
  "dsh_list",
  {
    title: "List DSH worker jobs and workflows",
    description: "List known DSH worker jobs (dsh_start) and parent workflows (dsh_delegate), newest first.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Rows returned per list. Default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}; the counts cover everything.`),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    // Both listings read the same snapshot directories, so they are awaited
    // together: the event loop stays free while the stat sweep runs, and a
    // second call after a job has settled costs a stat per file, not a read.
    const [all, flows] = await Promise.all([listJobs(), listWorkflows()]);
    const limit = Math.min(args.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return ok({
      count: all.length,
      jobs: all.slice(0, limit).map((job) => ({
        job_id: job.job_id,
        status: job.status,
        created_at: job.created_at,
        cwd: job.cwd,
        task: String(job.task ?? "").slice(0, 160),
      })),
      workflow_count: flows.length,
      workflows: flows.slice(0, limit).map((workflow) => ({
        job_id: workflow.job_id,
        status: workflow.status,
        phase: workflow.phase,
        created_at: workflow.created_at,
        cwd: workflow.cwd ?? workflow.request?.cwd,
        counts: workflow.counts ?? null,
      })),
      note: "Use dsh_get for a workflow's per-task evidence; a listed snapshot is not a live controller.",
    });
  },
);

/**
 * Wait on several jobs with one call.
 *
 * Parallel delegation is the point of this bridge, but a per-job wait makes the
 * caller poll each chain separately, so N parallel jobs cost N times the round
 * trips to learn the same thing. This returns as soon as the first job settles,
 * or with `wait_for: "all"` once none are left running.
 */
server.registerTool(
  "dsh_wait_any",
  {
    title: "Wait for the first of several DSH jobs",
    description:
      "Wait on a set of job ids at once and return as soon as the first settles, or with wait_for=\"all\" once all have. " +
      "Use instead of one dsh_wait per job. Each settled job returns the full status dsh_get would, including its answer, " +
      "so no follow-up read is needed; jobs still running are listed to wait on again.",
    inputSchema: {
      job_ids: z
        .array(z.string().min(1))
        .min(1)
        .describe(`The job ids to watch, from dsh_start or dsh_delegate. At most ${MAX_WAIT_ANY_JOBS}.`),
      max_wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Observation window in milliseconds. Default ${DEFAULT_WAIT_WINDOW_MS}, capped at ${MAX_FOREGROUND_WAIT_CAP_MS}.`),
      wait_for: z
        .enum(["any", "all"])
        .optional()
        .describe('"any" returns on the first settled job (default). "all" waits until none are still running.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const ids = [...new Set(args.job_ids)];
    if (ids.length > MAX_WAIT_ANY_JOBS) {
      return fail(`dsh_wait_any accepts at most ${MAX_WAIT_ANY_JOBS} job ids, got ${ids.length}`);
    }
    const window = Math.min(args.max_wait_ms ?? DEFAULT_WAIT_WINDOW_MS, MAX_FOREGROUND_WAIT_CAP_MS);
    const waitForAll = args.wait_for === "all";
    const startedAt = Date.now();
    const deadline = startedAt + window;

    /**
     * Is this id still worth waiting for?
     *
     * The poll loop below asks this several times a second, so it reads only
     * liveness. Building a full status here would extract and trim every
     * worker's answer on every tick to decide a boolean; the full read happens
     * once, after the loop.
     *
     * A workflow snapshot left by an earlier process has no controller and can
     * never settle in this one, so it counts as finished rather than holding
     * the whole window open on work nobody is running.
     */
    const pending = (found) => {
      if (found.error !== undefined) return false;
      if (found.workflow !== undefined) return found.live === true && found.workflow.ended_at === null;
      return found.job.status === "running";
    };

    // Both tests short-circuit, so a tick stops reading ids as soon as the
    // outcome is decided rather than re-reading all of them every time.
    const goalReached = waitForAll
      ? () => !ids.some((id) => pending(requireJob(id)))
      : () => ids.some((id) => !pending(requireJob(id)));
    while (Date.now() < deadline) {
      if (goalReached()) break;
      // Wake on whichever watched job settles first, so a waiter on a batch is
      // no later than the job it is waiting on. Any id this process does not own
      // has no signal, which is why the cap stays: it is what still bounds an id
      // whose only possible end is the window closing.
      await awaitAnySettlement(ids, Math.min(250, Math.max(25, deadline - Date.now())));
    }

    // One last read per id. Everything the caller would otherwise fetch with a
    // follow-up dsh_get is collected here instead: another round trip re-sends
    // the entire conversation, which costs far more than the text it returns.
    const finals = ids.map((id) => ({ id, found: requireJob(id) }));
    const stillRunning = finals.filter((entry) => pending(entry.found)).map((entry) => entry.id);
    const done = finals.filter((entry) => !pending(entry.found));

    // The answer budget is split evenly, so one talkative worker cannot crowd
    // out the others; below the floor it overruns instead, because an answer
    // trimmed to nothing forces exactly the follow-up read this is avoiding.
    const share =
      done.length === 0
        ? MAX_ANSWER_CHARS
        : Math.max(MIN_SHARED_ANSWER_CHARS, Math.floor(WAIT_ANY_ANSWER_BUDGET_CHARS / done.length));
    const full = ({ id, found }) => {
      if (found.error !== undefined) return { job_id: id, status: "unknown", error: found.error };
      if (found.workflow !== undefined) return workflowStatus(found.workflow, { live: found.live });
      return statusOf(found.job, { answerLimit: share });
    };

    // Work that needs attention first, so the ceiling below can only ever drop
    // the least interesting entries. A settled workflow carries a whole status
    // that no answer budget bounds, which is what makes the ceiling necessary:
    // without it, waiting on a set of workflows builds a result of any size.
    const uneventful = (row) => row.status === "done" || row.status === "awaiting_review";
    const settled = done.map(full).sort((a, b) => Number(uneventful(a)) - Number(uneventful(b)));
    const summarised = [];
    // One entry is always returned whole, even if it alone is over the ceiling:
    // an empty result would send the caller straight back to dsh_get.
    while (settled.length > 1 && JSON.stringify(settled).length > WAIT_ANY_MAX_CHARS) {
      const dropped = settled.pop();
      summarised.unshift({ job_id: dropped.job_id, kind: dropped.kind ?? null, status: dropped.status });
    }

    const trimmed = settled.filter((row) => row.answer_truncated === true).length;
    const payload = {
      waited_ms: Math.min(window, Date.now() - startedAt),
      wait_for: waitForAll ? "all" : "any",
      settled_count: done.length,
      running_count: stillRunning.length,
      settled,
      still_running: stillRunning,
      note:
        stillRunning.length === 0
          ? "All settled; each entry is complete."
          : "Settled entries are complete. Wait again on still_running; do not start duplicates.",
    };
    if (summarised.length > 0) {
      payload.settled_summarised = summarised;
      payload.note_summarised = `Past the ${WAIT_ANY_MAX_CHARS}-character ceiling these are listed as ids; read one with dsh_get.`;
    }
    if (trimmed > 0) {
      payload.answers_trimmed = trimmed;
      payload.note_answers = "Trimmed to share one budget; dsh_get with include_logs=true returns one whole.";
    }
    return ok(payload);
  },
);

/**
 * Report, and optionally delete, this bridge's finished state on disk.
 *
 * Every delegation leaves a snapshot behind, and evidence is the reason a
 * caller can accept work after the controller exits — so nothing is deleted
 * unless the caller asks. Running work is never a candidate.
 */
server.registerTool(
  "dsh_prune",
  {
    title: "Report or clean up finished DSH bridge state",
    description:
      "Report finished bridge state on disk and, with apply=true, delete what is older than the cutoff. Dry run by " +
      "default; only settled jobs and workflows are eligible, and anything still running is always kept. Touches the " +
      "bridge's own state only, never project files or DSH session history.",
    inputSchema: {
      older_than_days: z
        .number()
        .nonnegative()
        .optional()
        .describe(`Age cutoff in days from when the job ended. Default ${DEFAULT_PRUNE_AGE_DAYS}; 0 means every settled job. apply is the real guard.`),
      apply: z
        .boolean()
        .optional()
        .describe("false (default) reports only. true deletes, which cannot be undone."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    const days = args.older_than_days ?? DEFAULT_PRUNE_AGE_DAYS;
    const olderThanMs = days * 24 * 60 * 60 * 1000;
    const apply = args.apply === true;
    const [jobsResult, workflowsResult] = await Promise.all([
      pruneJobState({ olderThanMs, apply }),
      pruneWorkflowState({ olderThanMs, apply }),
    ]);
    const bytes = jobsResult.bytes + workflowsResult.bytes;
    return ok({
      older_than_days: days,
      applied: apply,
      jobs: jobsResult,
      workflows: workflowsResult,
      reclaimable_bytes: bytes,
      note: apply
        ? "Deleted. Evidence for those runs is gone; live work was untouched."
        : "Dry run only. Re-run with apply=true to delete, and note that a workflow's evidence goes with it.",
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
