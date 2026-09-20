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

/** Cap retained stdout per job, so one huge answer cannot exhaust memory. */
export const MAX_OUTPUT_CHARS = 200_000;

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

/** Deadline for the single planning worker inside a parent workflow. */
export const DEFAULT_PLANNING_TIMEOUT_MS = 20 * 60 * 1000;

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
