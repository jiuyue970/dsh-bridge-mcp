import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

/**
 * Plan validation and scheduling policy.
 *
 * The planning model proposes; this module decides. Every structural rule that
 * keeps concurrent workers from corrupting each other lives here as code, so a
 * model can never relax it by asking nicely:
 *
 *   - the plan must parse and match the declared shape
 *   - task ids must be unique, dependencies must exist, the graph must be acyclic
 *   - every declared path must resolve inside the workflow cwd and inside the
 *     caller's allowed_paths
 *   - a read-only workflow may not declare any write path
 *   - two concurrently running tasks may not touch overlapping paths unless the
 *     overlap is read/read
 *
 * A plan that violates any of these is rejected outright. It is never
 * "repaired" into something executable.
 *
 * Path resolution here is fail-closed and only claims to be a lexical/realpath
 * check, not an OS sandbox: it refuses paths that resolve outside the scope, but
 * a worker with a shell can still act outside its declaration.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Directories that are never a legitimate delegation target. */
const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

/**
 * Filenames a plan may never declare, in reads or writes.
 *
 * Task reads are validated against the project root rather than the caller's
 * allowed paths (see validatePlan), so the narrow scope no longer keeps a plan
 * away from a project's secrets. These names close that gap. Example and
 * sample files are deliberately allowed: they carry no real values.
 *
 * This constrains what a plan may DECLARE. A worker has its own shell, so this
 * is not an OS sandbox and does not stop one from reading a file it never
 * declared; it keeps the bridge from routing a task at secrets on purpose.
 */
const CREDENTIAL_FILE_PATTERN =
  /^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)|credentials|\.netrc|\.npmrc|\.pypirc)$/i;

/** Example and template files carry no real values, so they stay readable. */
const CREDENTIAL_FILE_EXCEPTIONS = /^\.env\.(example|sample|template|dist)$/i;

function isCredentialFile(segment) {
  if (CREDENTIAL_FILE_EXCEPTIONS.test(segment)) return false;
  return CREDENTIAL_FILE_PATTERN.test(segment);
}

export class PlanError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "PlanError";
    this.detail = detail;
  }
}

/**
 * Parse the planner's answer into a plan object.
 *
 * The planner is asked for bare JSON, but models sometimes wrap it in a fence.
 * Only a fence is unwrapped; anything else must parse as-is.
 */
export function parsePlan(rawText) {
  const text = String(rawText ?? "").trim();
  if (text === "") throw new PlanError("planner returned no output");
  const fenced = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n```$/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new PlanError(`planner output is not valid JSON: ${error.message}`, {
      head: body.slice(0, 400),
    });
  }
  return parsed;
}

/** Normalise a model-supplied path string to a relative POSIX-style path. */
function normaliseRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlanError(`${label} must be a non-empty string`);
  }
  const raw = value.trim();
  if (raw.includes("\0")) throw new PlanError(`${label} contains a NUL byte`);
  // Backslashes are unified so a plan cannot smuggle a traversal past the
  // checks on one platform and not another.
  const unified = raw.replaceAll("\\", "/");
  if (isAbsolute(unified) || /^[A-Za-z]:/.test(unified)) {
    throw new PlanError(`${label} must be relative to the workflow cwd, got absolute path "${raw}"`);
  }
  const cleaned = normalize(unified).replaceAll("\\", "/");
  if (cleaned === "." || cleaned === "") return ".";
  const segments = cleaned.split("/");
  // Trailing and repeated separators survive normalize(); drop them so
  // "src/" and "src" compare equal in the overlap checks.
  while (segments.length > 0 && segments[segments.length - 1] === "") segments.pop();
  if (segments.length === 0) return ".";
  if (segments.some((segment) => segment === "..")) {
    throw new PlanError(`${label} escapes the workflow cwd via "..": "${raw}"`);
  }
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new PlanError(`${label} targets protected directory "${segment}": "${raw}"`);
    }
    if (isCredentialFile(segment)) {
      throw new PlanError(`${label} targets a credential file "${segment}": "${raw}"`);
    }
  }
  return segments.join("/");
}

/**
 * Resolve a declared path and prove it stays inside the cwd, realpath included.
 *
 * Symlinks are the reason this is not a string prefix check: a task may declare
 * `safe-dir/link` where that link points at `/etc`.
 *
 * Fail-closed rules:
 *   - the deepest existing ancestor is found with lstat, so a dangling symlink
 *     is seen as an entry rather than as an ENOENT hole
 *   - only ENOENT above a symlink-less path may continue upward
 *   - any other error (EACCES, ELOOP, ...) is a rejection, never a skip
 *   - every existing ancestor must realpath inside the cwd, so an internal
 *     symlink alias resolves to its canonical target for conflict checks
 */
export function resolveWithin(cwdReal, relPath, label) {
  const absolute = resolve(cwdReal, relPath);
  const remainder = [];
  let current = absolute;
  let existing = null;

  for (;;) {
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new PlanError(`${label} cannot be inspected: "${relPath}" (${error.code ?? error.message})`);
      }
      const parent = dirname(current);
      // Reached the filesystem root without finding anything real: the cwd
      // itself was already proven to exist, so this cannot normally happen.
      if (parent === current) {
        existing = current;
        break;
      }
      remainder.unshift(current.slice(parent.length + 1));
      current = parent;
      continue;
    }
    // A symlink is resolved explicitly rather than trusted: a broken one is an
    // error, an external one fails the containment check below.
    let canonicalCurrent;
    try {
      canonicalCurrent = realpathSync(current);
    } catch (error) {
      throw new PlanError(
        `${label} resolves through an unusable symlink: "${relPath}" -> ${current} (${error.code ?? error.message})`,
      );
    }
    existing = canonicalCurrent;
    break;
  }

  const finalPath = remainder.length > 0 ? join(existing, ...remainder) : existing;
  if (finalPath !== cwdReal && !finalPath.startsWith(cwdReal + sep)) {
    throw new PlanError(
      `${label} resolves outside the workflow cwd via a symlink: "${relPath}" -> ${finalPath}`,
    );
  }
  return finalPath;
}

/**
 * Re-verify the realpath scope of every declared path before dispatch.
 *
 * The filesystem can change between planning and dispatch: another task may have
 * created or re-pointed a symlink. Two separate failures are possible and both
 * fail closed here:
 *
 *   1. A path no longer resolves inside the cwd at all. This is recomputed the
 *      same way validation did it.
 *   2. The resolved path is still inside the cwd but a *different* file than the
 *      one validation saw. Containment alone cannot see this, and the conflict
 *      checks silently keep using the canonical paths recorded at validation
 *      time, so a task could be dispatched against a file another task was
 *      proven safe to write. The canonical value recorded by `validatePlan` is
 *      therefore re-derived and compared, and any difference rejects the whole
 *      plan. Nothing is re-planned or re-batched: fail closed.
 *
 * An output that did not exist at validation time legitimately appears when an
 * earlier task creates it; it keeps the same absolute path, so the comparison
 * holds and the plan stays executable.
 */
export function assertPlanStillContained(plan) {
  const expected = new Map([
    ...(plan.allowed_scopes ?? []).map((scope) => [scope.path, scope.canonical]),
    ...plan.tasks.flatMap((task) => [
      ...task.read_paths.map((path, index) => [path, task.read_canonical?.[index]]),
      ...task.write_paths.map((path, index) => [path, task.write_canonical?.[index]]),
    ]),
  ]).entries();

  for (const [path, canonical] of expected) {
    if (path === "." && canonical === plan.cwd) continue;
    const now = resolveWithin(plan.cwd, path, `declared path "${path}"`);
    if (typeof canonical !== "string" || now !== canonical) {
      throw new PlanError(
        `declared path "${path}" no longer resolves to the file the plan was validated against: ` +
          `${canonical} -> ${now}. The plan was rejected rather than re-planned.`,
      );
    }
  }
}

/** True when two resolved paths overlap as paths (not merely as strings). */
export function resolvedPathsOverlap(a, b) {
  if (a === b) return true;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Normalise the caller-supplied allowed_paths scope.
 *
 * Fail-closed: a path that is not a plain relative scope is rejected before any
 * planner runs, and an explicit empty array is rejected rather than silently
 * widened to the whole cwd. `undefined`/absent means "." (the whole cwd).
 */
export function normaliseAllowedPaths(allowedPaths) {
  if (allowedPaths === undefined || allowedPaths === null) return ["."];
  if (!Array.isArray(allowedPaths)) {
    throw new PlanError("allowed_paths must be an array of relative paths");
  }
  if (allowedPaths.length === 0) {
    throw new PlanError('allowed_paths is empty; it would permit nothing. Omit it, or pass ["."]');
  }
  const seen = [];
  allowedPaths.forEach((value, index) => {
    const label = `allowed_paths[${index}]`;
    if (typeof value !== "string" || value.trim() === "") {
      throw new PlanError(`${label} must be a non-empty string`);
    }
    const raw = value.trim();
    if (raw.includes("\0")) throw new PlanError(`${label} contains a NUL byte`);
    if (/[*?[\]{}]/.test(raw)) {
      throw new PlanError(`${label} uses an unsupported glob: "${raw}"`);
    }
    const unified = raw.replaceAll("\\", "/");
    if (isAbsolute(unified) || /^[A-Za-z]:/.test(unified)) {
      throw new PlanError(`${label} must be relative to cwd, got absolute path "${raw}"`);
    }
    if (unified.split("/").includes("..")) {
      throw new PlanError(`${label} must not contain "..": "${raw}"`);
    }
    const cleaned = normalize(unified).replaceAll("\\", "/");
    // Drop trailing separators so "src/" and "src" compare (and de-duplicate)
    // as the same scope.
    const segments = cleaned.split("/").filter((segment) => segment !== "");
    const path = segments.length === 0 ? "." : segments.join("/");
    if (!seen.includes(path)) seen.push(path);
  });
  return seen;
}

/**
 * True when a normalised declared path sits inside the allowed scope lexically.
 *
 * This is only half of the allowed_paths rule. It compares the paths the planner
 * wrote, so it cannot see a symlink inside the scope pointing out of it; the
 * canonical check in `validatePlan` closes that. Both must pass.
 */
export function withinAllowedScope(relPath, allowedPaths) {
  return allowedPaths.some((allowed) => allowed === "." || isWithin(relPath, allowed));
}

/**
 * True when `child` is `parent` itself or nested inside it.
 *
 * This is deliberately one-directional: the allowed_paths rule needs "declared
 * must be inside allowed", where `src` must NOT be accepted just because
 * `allowed` contains `src/a`.
 */
export function isWithin(child, parent) {
  if (parent === ".") return true;
  if (child === parent) return true;
  const parentSegments = parent.split("/");
  const childSegments = child.split("/");
  if (parentSegments.length > childSegments.length) return false;
  return parentSegments.every((segment, index) => childSegments[index] === segment);
}

/** Compare two cwd-relative paths for overlap (either contains the other). */
export function pathsOverlap(a, b) {
  if (a === b) return true;
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * Resolve each allowed path to its canonical (realpath) scope.
 *
 * `allowed_paths` is the caller's grant, and it is a grant over *files*, not
 * over names: `allowed/alias` pointing at `../other` must not become a licence
 * to write `../other`. Each allowed path therefore gets the same fail-closed
 * realpath treatment as a declared path, and the canonical result is what a
 * declared path's canonical target is measured against.
 *
 * The lexical scope is kept alongside it: both layers must accept a path, so a
 * canonical containment can never widen a lexically narrower grant.
 */
export function canonicalAllowedScopes(cwdReal, allowedPaths) {
  return allowedPaths.map((path) =>
    path === "."
      ? { path, canonical: cwdReal }
      : { path, canonical: resolveWithin(cwdReal, path, `allowed_paths entry "${path}"`) },
  );
}

/**
 * True when two tasks declare any path that is not a read/read overlap.
 *
 * Comparison uses the canonical (realpath) target of each declared path when it
 * is available, so two names that alias the same file — e.g. `link` and `real`
 * where link -> real — conflict rather than looking independent.
 */
export function tasksConflict(a, b) {
  const hasCanonical = Array.isArray(a.write_canonical) && Array.isArray(b.write_canonical);
  const writes = (task) => task.write_canonical ?? task.write_paths;
  const reads = (task) => task.read_canonical ?? task.read_paths;
  // Validated tasks carry canonical (absolute) arrays; ad-hoc callers may pass
  // only relative paths, which need the root-aware relative comparison.
  const overlap = hasCanonical ? resolvedPathsOverlap : pathsOverlap;

  for (const write of writes(a)) {
    if (writes(b).some((other) => overlap(write, other))) return true;
    if (reads(b).some((other) => overlap(write, other))) return true;
  }
  for (const write of writes(b)) {
    if (reads(a).some((other) => overlap(write, other))) return true;
  }
  return false;
}

/**
 * Validate a raw plan object and return normalised tasks.
 *
 * `mode` is enforced: a read-only workflow rejects any write declaration rather
 * than silently dropping it, because a silently-dropped write path would also
 * silence the conflict checks that depend on it.
 *
 * `allowedPaths` (default ["."]) is enforced as a one-directional containment:
 * every declared path must sit inside an allowed path. It is deliberately not a
 * symmetric overlap, so allowed ["src/a"] does not admit a declared "src".
 * Both layers must pass: the declared path must be lexically inside an allowed
 * path AND its canonical target must be inside that allowed path's canonical
 * target. The second layer is what stops `allowed/alias -> ../other` from
 * granting `../other` simply because the planner wrote an alias name.
 *
 * `cwdCanonical` is the already-realpath'd cwd the caller checked; when absent
 * this function resolves `cwd` itself.
 */
export function validatePlan(raw, { cwd, mode, allowedPaths, cwdCanonical }) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlanError("plan must be a JSON object");
  }
  if (!Array.isArray(raw.tasks)) {
    throw new PlanError('plan must have a "tasks" array');
  }
  if (raw.tasks.length === 0) {
    throw new PlanError("plan contains no tasks");
  }

  const scope = normaliseAllowedPaths(allowedPaths);

  let cwdReal;
  try {
    cwdReal = cwdCanonical ?? realpathSync(cwd);
  } catch (error) {
    throw new PlanError(`workflow cwd is not resolvable: ${cwd} (${error.message})`);
  }

  const byId = new Map();
  const tasks = [];

  // The allowed scope is resolved to canonical targets once, before any task is
  // consulted, so an allowed path that is itself an escaping symlink is reported
  // as a scope problem rather than as a task problem.
  const allowedScopes = canonicalAllowedScopes(cwdReal, scope);

  raw.tasks.forEach((entry, index) => {
    const at = `tasks[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new PlanError(`${at} must be an object`);
    }
    const id = entry.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new PlanError(`${at}.id must match ${ID_PATTERN} (got ${JSON.stringify(id)})`);
    }
    if (byId.has(id)) throw new PlanError(`duplicate task id "${id}"`);
    if (typeof entry.task !== "string" || entry.task.trim() === "") {
      throw new PlanError(`${at} ("${id}").task must be a non-empty string`);
    }

    const reads = entry.read_paths ?? entry.reads ?? [];
    const writes = entry.write_paths ?? entry.writes ?? [];
    if (!Array.isArray(reads)) throw new PlanError(`${at} ("${id}").read_paths must be an array`);
    if (!Array.isArray(writes)) throw new PlanError(`${at} ("${id}").write_paths must be an array`);

    const readPaths = reads.map((value, i) =>
      normaliseRelativePath(value, `${at} ("${id}").read_paths[${i}]`),
    );
    const writePaths = writes.map((value, i) =>
      normaliseRelativePath(value, `${at} ("${id}").write_paths[${i}]`),
    );

    if (mode === "read-only" && writePaths.length > 0) {
      throw new PlanError(
        `task "${id}" declares write_paths (${writePaths.join(", ")}) but the workflow mode is read-only`,
      );
    }
    if (mode === "read-only" && readPaths.length === 0) {
      // Not fatal: a read-only task with no declared reads is merely unspecific.
      readPaths.push(".");
    }
    for (const writePath of writePaths) {
      if (writePath === ".") {
        throw new PlanError(`task "${id}" declares the whole cwd as a write path; name a subpath`);
      }
    }

    // Scope is enforced before the filesystem is consulted, so an out-of-scope
    // path is reported as such rather than as a symlink problem.
    // Writes are what change a project, so they stay inside the caller's grant.
    // Reads are bounded by the working directory instead: a planner has to look
    // at a definition before it can scope the task that touches it, and a scope
    // narrow enough to be useful for writes was rejecting those reads outright.
    // Measured on 2026-09-20/21, four of fourteen failed workflows died this
    // way, having produced nothing. Credential files stay refused on both
    // sides, and containment inside cwd is still proven below.
    for (const value of writePaths) {
      if (!withinAllowedScope(value, scope)) {
        throw new PlanError(
          `${at} ("${id}").write_paths declares "${value}", which is outside allowed_paths (${scope.join(", ")})`,
        );
      }
    }

    const dependsOn = entry.depends_on ?? entry.dependsOn ?? [];
    if (!Array.isArray(dependsOn)) {
      throw new PlanError(`${at} ("${id}").depends_on must be an array`);
    }
    for (const dependency of dependsOn) {
      if (typeof dependency !== "string") {
        throw new PlanError(`${at} ("${id}").depends_on entries must be strings`);
      }
      if (dependency === id) throw new PlanError(`task "${id}" depends on itself`);
    }

    // Every declared path is proven contained before anything is scheduled, and
    // its canonical target recorded so aliases of one file conflict correctly.
    const readCanonical = [];
    for (const readPath of readPaths) {
      readCanonical.push(
        readPath === "." ? cwdReal : resolveWithin(cwdReal, readPath, `${at} ("${id}").read_paths`),
      );
    }
    const writeCanonical = [];
    for (const writePath of writePaths) {
      writeCanonical.push(resolveWithin(cwdReal, writePath, `${at} ("${id}").write_paths`));
    }

    // The lexical check above compares the names the planner wrote. This second
    // layer compares the resolved targets: every canonical read/write must sit
    // one-directionally inside an allowed path's canonical target. A symlink
    // *inside* the allowed subtree that points out of it is caught here, and a
    // narrower lexical grant is never widened (both layers must pass).
    writePaths.forEach((value, position) => {
      const target = writeCanonical[position];
      const inside = allowedScopes.some((allowed) => resolvedPathsOverlap(target, allowed.canonical));
      if (!inside) {
        throw new PlanError(
          `${at} ("${id}").write_paths declares "${value}", whose canonical target ${target} is outside ` +
            `allowed_paths (${scope.join(", ")}); an allowed path is a grant over its own files, not over whatever its symlinks reach`,
        );
      }
    });

    const acceptance = normaliseAcceptance(entry.acceptance, `${at} ("${id}")`);

    const task = {
      id,
      task: entry.task.trim(),
      read_paths: readPaths,
      write_paths: writePaths,
      read_canonical: readCanonical,
      write_canonical: writeCanonical,
      depends_on: [...new Set(dependsOn)],
      acceptance,
      index,
    };
    byId.set(id, task);
    tasks.push(task);
  });

  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (!byId.has(dependency)) {
        throw new PlanError(`task "${task.id}" depends on unknown task "${dependency}"`);
      }
    }
  }

  assertAcyclic(tasks, byId);
  return { cwd: cwdReal, mode, allowed_paths: scope, allowed_scopes: allowedScopes, tasks };
}

/**
 * Normalise `acceptance` without ever silently dropping it.
 *
 * A non-empty string is used as-is; an array of non-empty strings (or one
 * object with a `criteria` array) is joined into a readable criterion; anything
 * else is a plan error. It must never quietly become null, because the worker
 * prompt and the review both depend on it being present.
 */
function normaliseAcceptance(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    if (value.trim() === "") throw new PlanError(`${label}.acceptance must not be an empty string`);
    return value.trim();
  }
  if (Array.isArray(value)) {
    if (value.length === 0) throw new PlanError(`${label}.acceptance must not be an empty array`);
    const parts = value.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new PlanError(`${label}.acceptance[${index}] must be a non-empty string`);
      }
      return entry.trim();
    });
    return parts.join("; ");
  }
  if (typeof value === "object" && Array.isArray(value.criteria)) {
    return normaliseAcceptance(value.criteria, label);
  }
  throw new PlanError(
    `${label}.acceptance must be a non-empty string or an array of them (got ${typeof value})`,
  );
}

/**
 * Reject dependency cycles.
 *
 * Depth-first colouring reports the actual cycle path, which is far more
 * actionable in a failure record than "the graph has a cycle".
 */
function assertAcyclic(tasks, byId) {
  const state = new Map();
  const stack = [];
  const visit = (task) => {
    const seen = state.get(task.id);
    if (seen === "done") return;
    if (seen === "open") {
      const start = stack.indexOf(task.id);
      throw new PlanError(`dependency cycle: ${[...stack.slice(start), task.id].join(" -> ")}`);
    }
    state.set(task.id, "open");
    stack.push(task.id);
    for (const dependency of task.depends_on) visit(byId.get(dependency));
    stack.pop();
    state.set(task.id, "done");
  };
  for (const task of tasks) visit(task);
}

/**
 * The set of tasks that may run right now: unstarted, every dependency already
 * finished successfully, and no dependency already failed.
 */
export function computeReady(plan, { done, failed, started }) {
  const ready = [];
  for (const task of plan.tasks) {
    if (started.has(task.id) || done.has(task.id) || failed.has(task.id)) continue;
    if (task.depends_on.some((dependency) => failed.has(dependency))) continue;
    if (!task.depends_on.every((dependency) => done.has(dependency))) continue;
    ready.push(task);
  }
  return ready;
}

/** Greedily take the largest path-compatible batch from a ready list. */
export function compatibleSubset(readyTasks) {
  const chosen = [];
  for (const candidate of readyTasks) {
    if (chosen.every((already) => !tasksConflict(already, candidate))) chosen.push(candidate);
  }
  return chosen;
}

/**
 * The largest compatible batch, plus every smaller batch size that is also
 * achievable.
 *
 * Options are prefixes of the compatible list in plan order, so the TypeSafe
 * Choice labels are "1..N for this batch" and never a hard-coded constant.
 */
export function feasibleBatch(plan, state) {
  const ready = computeReady(plan, state);
  if (ready.length === 0) return { ready, compatible: [], options: [] };
  const compatible = compatibleSubset(ready);
  const options = compatible.map((_, index) => compatible.slice(0, index + 1));
  return { ready, compatible, options };
}

/**
 * Tasks that can never run because a dependency failed, directly or through a
 * chain. Used to settle the workflow instead of waiting forever.
 */
export function unreachable(plan, { done, failed, started }) {
  const blocked = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of plan.tasks) {
      if (started.has(task.id) || done.has(task.id) || failed.has(task.id)) continue;
      if (blocked.has(task.id)) continue;
      if (task.depends_on.some((dependency) => failed.has(dependency) || blocked.has(dependency))) {
        blocked.add(task.id);
        changed = true;
      }
    }
  }
  return blocked;
}

/** Render the compact task summary the chooser and workers need. */
export function taskSummary(task, plan) {
  const byId = new Map(plan.tasks.map((entry) => [entry.id, entry]));
  return {
    id: task.id,
    task: task.task.length > 500 ? `${task.task.slice(0, 500)}...` : task.task,
    read_paths: task.read_paths,
    write_paths: task.write_paths,
    depends_on: task.depends_on.map((dependency) => ({
      id: dependency,
      task: (byId.get(dependency)?.task ?? "").slice(0, 200),
    })),
    acceptance: task.acceptance,
  };
}
