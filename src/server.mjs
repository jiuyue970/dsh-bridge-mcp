#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { credentialStatus } from "./choices.mjs";
import {
  DEFAULT_PROFILE,
  DEFAULT_TAIL_CHARS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_WORKFLOW_TIMEOUT_MS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./config.mjs";
import { cancelJob, listJobs, readJob, startJob, statusOf } from "./jobs.mjs";
import {
  cancelWorkflow,
  childStatus,
  listWorkflows,
  plannerJobId,
  readWorkflow,
  startWorkflow,
  waitWorkflow,
  workflowStatus,
} from "./workflow.mjs";

/** MCP tool results are JSON text; never throw out of a handler. */
function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 1) }] };
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
      "Delegate one complete objective to a managed DeepSeek Harness (DSH) workflow and return a parent job_id immediately. " +
      "The parent plans with a read-only DSH worker, validates the plan in code, judges safe concurrency with TypeSafe, " +
      "runs one DSH worker per task, and ends in status awaiting_review with compact evidence per task. " +
      "It does NOT claim the work is accepted: check the returned evidence and files yourself. " +
      "Use dsh_get/dsh_wait/dsh_cancel/dsh_list on the returned job_id exactly as with dsh_start. " +
      "Prefer this over dsh_start when a task needs decomposition, several files, or implementation plus tests.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "The complete objective including every constraint, relevant path, and the definition of done. Workers see only what the plan tells them.",
        ),
      cwd: z
        .string()
        .min(1)
        .describe(
          "Absolute working directory for the whole workflow. Required and explicit: every task path is validated relative to it.",
        ),
      mode: z
        .enum(["read-only", "workspace-write"])
        .describe(
          "read-only forbids all writes: any plan declaring a write path is rejected. workspace-write allows writes inside declared paths.",
        ),
      allowed_paths: z
        .array(z.string())
        .optional()
        .describe(
          'Paths the objective may touch, relative to cwd. Defaults to the project root ("."). Plans declaring paths outside this set are rejected.',
        ),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          `Total deadline in milliseconds for planning plus every task. Default ${DEFAULT_WORKFLOW_TIMEOUT_MS}, capped at ${MAX_WORKFLOW_TIMEOUT_MS}.`,
        ),
      profile: z
        .string()
        .optional()
        .describe(`DSH profile to boot for every worker. Default "${DEFAULT_PROFILE}".`),
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
        timeoutMs: args.timeout_ms,
        profile: args.profile,
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
        note:
          "Running in background. Read it with dsh_get, block with dsh_wait, stop it with dsh_cancel. " +
          "Final status is awaiting_review: the evidence is a worker report you must verify yourself.",
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
      "Delegate one self-contained coding task to a DeepSeek Harness (DSH) headless worker and return a job_id immediately. " +
      "The worker runs in the given working directory with a full coding tool set (bash, file read/write/search, skills) and reports only its final answer. " +
      "Prefer this over dsh_run_sync for anything that may take more than a couple of minutes. " +
      "Do not start a second job for the same task while the first is still running.",
    inputSchema: {
      task: z
        .string()
        .min(1)
        .describe(
          "The complete, self-contained task. The worker sees only this text plus its working directory, so include every constraint, path, and expected outcome.",
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
        .describe("Deadline in milliseconds. The worker is terminated when it expires. Default 30 minutes."),
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
        timeoutMs: args.timeout_ms,
        profile: args.profile,
      });
      return ok({
        job_id: job.job_id,
        status: job.status,
        pid: job.pid ?? null,
        cwd: job.cwd,
        note: "Running in background. Read it with dsh_get, or block with dsh_wait.",
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
      "Read compact status for a DSH job. Works on both a plain worker job from dsh_start and a parent workflow from dsh_delegate. " +
      "A workflow returns phase, counts, per-task evidence summaries and child job ids by default. " +
      "Bulk fields (stderr tail, full plan, worker transcripts) are omitted unless include_logs asks for them.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id returned by dsh_start or dsh_delegate."),
      include_logs: z
        .boolean()
        .optional()
        .describe("Include a stderr tail, or for a workflow the full decision and plan detail. Default false."),
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
      "Wait up to max_wait_ms for a job to finish, then return its status. Works on worker jobs and on dsh_delegate parent workflows. " +
      "Returns as soon as the job settles. This never cancels the job; a job still running after the window stays running.",
    inputSchema: {
      job_id: z.string().min(1).describe("The job_id returned by dsh_start or dsh_delegate."),
      max_wait_ms: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Observation window in milliseconds. Default 60000, capped at 600000."),
      include_logs: z.boolean().optional().describe("Include a stderr tail when settling. Default false."),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    const found = requireJob(args.job_id);
    if (found.error !== undefined) return fail(found.error);
    const window = Math.min(args.max_wait_ms ?? 60_000, 600_000);
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
        payload.note = "Still running when the window closed; call dsh_wait or dsh_get again.";
      }
      return ok(payload);
    }

    let current = found.job;
    while (Date.now() < deadline) {
      if (current.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      current = readJob(args.job_id) ?? current;
    }
    const payload = statusOf(current, { includeLogs: args.include_logs === true });
    payload.waited_ms = window - Math.max(0, deadline - Date.now());
    if (current.status === "running") {
      payload.note = "Still running when the window closed; call dsh_wait or dsh_get again.";
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
      "Return the last N characters of the worker's output. Note that DSH headless delivers its answer in one write at the end, " +
      "so a running job usually shows nothing here; this is mainly useful after the job settles.",
    inputSchema: {
      job_id: z
        .string()
        .min(1)
        .describe("A worker job_id, or a workflow job_id plus a child task_id to tail one worker."),
      chars: z.number().int().positive().optional().describe(`Tail length. Default ${DEFAULT_TAIL_CHARS}.`),
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
    const n = args.chars ?? DEFAULT_TAIL_CHARS;

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
      const out = String(job.stdout ?? "");
      const err = String(job.stderr ?? "");
      return ok({
        job_id: child.job_id,
        task_id: child.task_id,
        status: job.status,
        stdout_tail: out.slice(-n),
        stderr_tail: err.slice(-n),
        stdout_chars: out.length,
      });
    }

    const job = found.job;
    const out = String(job.stdout ?? "");
    const err = String(job.stderr ?? "");
    return ok({
      job_id: job.job_id,
      status: job.status,
      stdout_tail: out.slice(-n),
      stderr_tail: err.slice(-n),
      stdout_chars: out.length,
    });
  },
);

/** Cancel a running job or parent workflow. */
server.registerTool(
  "dsh_cancel",
  {
    title: "Cancel a DSH worker job or workflow",
    description:
      "Request cancellation of a running DSH worker, or of a dsh_delegate parent workflow. " +
      "Cancelling a workflow stops any further task from being started and requests cancellation of the workers it started, " +
      "reporting exactly which requests were made and which were not confirmed. " +
      "Use when the user asks to stop or the task is obsolete. " +
      "Do not cancel merely because the job is quiet: a long task can run for many minutes without output.",
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
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    const all = listJobs();
    const flows = listWorkflows();
    return ok({
      count: all.length,
      jobs: all.slice(0, 50).map((job) => ({
        job_id: job.job_id,
        status: job.status,
        created_at: job.created_at,
        cwd: job.cwd,
        task: String(job.task ?? "").slice(0, 160),
      })),
      workflow_count: flows.length,
      workflows: flows.slice(0, 50).map((workflow) => ({
        job_id: workflow.job_id,
        status: workflow.status,
        phase: workflow.phase,
        created_at: workflow.created_at,
        cwd: workflow.cwd ?? workflow.request?.cwd,
        counts: workflow.counts ?? null,
        note: "Use dsh_get for per-task evidence; a snapshot is not a live controller.",
      })),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
