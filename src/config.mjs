import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const SERVER_NAME = "dsh-bridge";
export const SERVER_VERSION = "0.1.0";

/** The CLI this bridge drives. Override with DSH_BIN. */
export const DEFAULT_DSH_BIN = "dsh";

/**
 * Profile to boot for each delegated task.
 *
 * `headless` is the one-shot profile: it answers one task, prints the final
 * assistant message to stdout, and exits. Measured behaviour (2026-09-18):
 *   - stdout: final assistant message only, delivered as one write at the end
 *   - stderr: EMPTY unless something fails (no reasoning stream on the wire)
 *   - exit code: 0 on success
 *   - cwd: inherited from the spawning process
 */
export const DEFAULT_PROFILE = "headless";

/**
 * Default task deadline. DSH headless has no built-in timeout, so the bridge
 * enforces one; without it a wedged worker would occupy a job slot forever.
 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** Upper bound a caller may request for one foreground wait window. */
export const MAX_FOREGROUND_WAIT_CAP_MS = 10 * 60 * 1000;

/**
 * Default window for `dsh_wait`.
 *
 * Every poll is a full round trip that re-sends the caller's whole
 * conversation, so a short window is the dominant cost of delegation, not a
 * safety feature. Measured on 2026-09-20: 45-second windows produced 2,250
 * idle polls across 2,997 jobs, and `dsh_wait` accounted for 67.5% of the
 * caller's token usage. A 300-second window removes about 89% of those idle
 * polls while still returning the moment a job settles.
 */
export const DEFAULT_WAIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * How long `dsh_start` may hold the call open before handing back a job id.
 *
 * Most delegated jobs are short: on 2026-09-20 the 90th percentile finished in
 * about two seconds. Returning such a job's answer inline collapses the usual
 * start-then-poll pair into one round trip. The cap is deliberately small so a
 * long job still becomes a background job quickly.
 */
export const MAX_INLINE_WAIT_MS = 60 * 1000;

/**
 * Named deadlines, so a caller picks a shape instead of guessing milliseconds.
 *
 * A single flat timeout misfits both ends: read-only questions finish in
 * seconds yet reserved half an hour, while long builds hit the wall and lose
 * partially applied work. Measured on 2026-09-19/20, 18.2% of delegated jobs
 * timed out against a 90th percentile runtime of about 15 minutes.
 */
export const TIMEOUT_TIERS = {
  investigate: 5 * 60 * 1000,
  edit: 15 * 60 * 1000,
  build: 30 * 60 * 1000,
};

/** Workflow-level equivalents: planning plus every task in one deadline. */
export const WORKFLOW_TIMEOUT_TIERS = {
  investigate: 20 * 60 * 1000,
  edit: 60 * 60 * 1000,
  build: 2 * 60 * 60 * 1000,
};

/** Most jobs a single `dsh_wait_any` call may watch at once. */
export const MAX_WAIT_ANY_JOBS = 32;

/** Default age threshold for `dsh_prune`. */
export const DEFAULT_PRUNE_AGE_DAYS = 7;

/** Cap retained stdout per job, so one huge answer cannot exhaust memory. */
export const MAX_OUTPUT_CHARS = 200_000;

/**
 * Characters of a worker's answer returned by default.
 *
 * `MAX_OUTPUT_CHARS` bounds what the bridge keeps; this bounds what it hands
 * back. They are different jobs: a tool result enters the caller's
 * conversation and is re-sent with every later request, so one talkative
 * worker would otherwise charge the caller for its whole report over and over.
 * The full text stays in the job snapshot, and `include_logs` returns it whole.
 * Matches the workflow reader's budget so both paths behave the same way.
 */
export const MAX_ANSWER_CHARS = 12_000;

/** How much of the tail to return when a caller asks for the last output. */
export const DEFAULT_TAIL_CHARS = 4_000;

/**
 * Root for all bridge runtime state.
 *
 * `tmpdir()` is the default, but it is not stable across launchers: an MCP host
 * that sanitizes the child environment can strip TMPDIR, so the same bridge
 * would read and write state in a different directory than the one a sibling
 * process used. DSH_BRIDGE_STATE_DIR pins it when that matters.
 */
export const STATE_ROOT =
  process.env.DSH_BRIDGE_STATE_DIR && process.env.DSH_BRIDGE_STATE_DIR.trim() !== ""
    ? resolve(process.env.DSH_BRIDGE_STATE_DIR.trim())
    : resolve(tmpdir(), "dsh-bridge");

/** Job state directory. One JSON file per job, for cross-call recovery. */
export const JOB_ROOT = resolve(STATE_ROOT, "jobs");

/**
 * Parent workflow state directory, deliberately a sibling subtree of JOB_ROOT
 * so a plain `dsh_list` never mistakes a parent snapshot for a worker job.
 */
export const WORKFLOW_ROOT = resolve(JOB_ROOT, "workflows");

/** Default deadline for one dsh_delegate parent workflow. */
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 60 * 60 * 1000;

/** Upper bound a caller may request for one dsh_delegate deadline. */
export const MAX_WORKFLOW_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Deadline for the single planning worker inside a parent workflow.
 *
 * Planning reads before it writes anything, so it is the slowest phase on a
 * large objective — and its timeout is total loss, because a workflow that
 * never produced a plan never dispatched a worker. Measured on 2026-09-20/21:
 * six of fourteen failed workflows ended exactly at the previous 20-minute
 * ceiling, having produced nothing.
 */
export const DEFAULT_PLANNING_TIMEOUT_MS = 40 * 60 * 1000;

/** Characters of a finished worker's answer kept as downstream context. */
export const MAX_DEPENDENCY_CONTEXT_CHARS = 4_000;

/** Characters of worker answer persisted into the workflow artifact file. */
export const MAX_ARTIFACT_ANSWER_CHARS = 20_000;

/**
 * Environment variables scrubbed before the child is spawned.
 *
 * The child inherits the parent environment minus credential-shaped names, so
 * a third-party key cannot silently reach a delegated worker. DSH resolves its
 * own provider keys from $DSH_HOME/.credentials.yaml, not from these, so
 * scrubbing does not break the child's model access.
 */
export const CREDENTIAL_ENV_PATTERN =
  /(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_PAT|AUTH)/i;

/** Child environment variables kept even when they look credential-shaped. */
export const CREDENTIAL_ENV_ALLOWLIST = new Set([
  "DSH_HOME",
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "TMPDIR",
  "LANG",
  "LC_ALL",
]);

/**
 * How the TypeSafe API key is obtained.
 *
 * The key itself is never embedded, logged, or copied: it is read from the
 * process environment, or from the single named variable inside an env file
 * whose path the operator supplies. Only the path is configuration.
 */
export const TYPESAFE_ENV_FILE_VAR = "DSH_TYPESAFE_ENV_FILE";
export const TYPESAFE_API_KEY_VAR = "TYPESAFE_API_KEY";

/** Per-attempt TypeSafe HTTP timeout; retries are disabled (see choices.mjs). */
export const TYPESAFE_TIMEOUT_MS = 15_000;

/**
 * The only id shape this bridge ever mints: `randomUUID()` for jobs and for
 * parent workflows.
 *
 * Ids arrive from a caller and are joined into a file path, so the shape is
 * checked before any join: `../../secrets` and `a/b` are strings that would
 * otherwise read outside JOB_ROOT or WORKFLOW_ROOT. Anything that is not one of
 * our own UUIDs is treated as "no such job", never as a path.
 */
export const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True only for an id this system could have generated. */
export function isSystemJobId(id) {
  return typeof id === "string" && JOB_ID_PATTERN.test(id);
}
