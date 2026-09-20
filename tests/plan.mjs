#!/usr/bin/env node
// Offline policy checks for plan validation and evidence grading.
//   node tests/plan.mjs
//
// No network, no subprocesses: this exercises the code that decides what may
// run. Every rule here is a security or correctness invariant, so a regression
// must fail loudly rather than degrade into "the model will handle it".
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeJob, parseEvidence } from "../src/evidence.mjs";
import {
  PlanError,
  assertPlanStillContained,
  feasibleBatch,
  isWithin,
  normaliseAllowedPaths,
  parsePlan,
  pathsOverlap,
  tasksConflict,
  unreachable,
  validatePlan,
} from "../src/plan.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-plan-"));
const project = join(root, "project");
mkdirSync(join(project, "src"), { recursive: true });
mkdirSync(join(project, "docs"), { recursive: true });
writeFileSync(join(project, "src", "index.js"), "export const x = 1;\n");

// A symlink pointing outside the project: the escape a string check would miss.
const outside = join(root, "outside");
mkdirSync(outside, { recursive: true });
writeFileSync(join(outside, "secret.txt"), "sensitive\n");
symlinkSync(outside, join(project, "escape-link"));

// An internal symlink alias plus a dangling link: aliases must be compared by
// their real target, and a broken link must be refused outright.
writeFileSync(join(project, "src", "real.js"), "export const real = 1;\n");
symlinkSync(join(project, "src", "real.js"), join(project, "alias.js"));
symlinkSync(join(project, "src", "nowhere.js"), join(project, "dangling.js"));

/** Validate a plan against the fixture project. */
function validate(tasks, mode = "workspace-write", allowedPaths = undefined) {
  return validatePlan({ tasks }, { cwd: project, mode, allowedPaths });
}

/** Assert a plan is rejected, and that the message names the real problem. */
function rejects(tasks, needle, mode = "workspace-write", allowedPaths = undefined) {
  assert.throws(
    () => validate(tasks, mode, allowedPaths),
    (error) => {
      assert.ok(error instanceof PlanError, `expected PlanError, got ${error}`);
      assert.match(error.message, needle, `message ${JSON.stringify(error.message)} must match ${needle}`);
      return true;
    },
  );
}

const base = (over = {}) => ({ id: "t1", task: "do a thing", ...over });

try {
  // --- parsing -------------------------------------------------------------
  assert.deepEqual(parsePlan('{"tasks":[]}'), { tasks: [] });
  assert.deepEqual(parsePlan('```json\n{"tasks":[]}\n```'), { tasks: [] });
  assert.throws(() => parsePlan("I think we should first..."), PlanError);
  assert.throws(() => parsePlan(""), PlanError);
  console.log("ok - plan JSON parsing accepts bare and fenced objects only");

  // --- structural validation ----------------------------------------------
  rejects([{ task: "no id" }], /\.id must match/);
  rejects([base({ id: "bad id!" })], /\.id must match/);
  rejects([base(), base({ task: "second" })], /duplicate task id/);
  rejects([base({ task: "   " })], /\.task must be a non-empty string/);
  rejects([base({ depends_on: ["ghost"] })], /unknown task "ghost"/);
  rejects([base({ depends_on: ["t1"] })], /depends on itself/);
  rejects(
    [base({ id: "a", depends_on: ["b"] }), base({ id: "b", depends_on: ["a"] })],
    /dependency cycle: a -> b -> a/,
  );
  rejects(
    [
      base({ id: "a", depends_on: ["b"] }),
      base({ id: "b", depends_on: ["c"] }),
      base({ id: "c", depends_on: ["a"] }),
    ],
    /dependency cycle/,
  );
  rejects([base({ read_paths: "src" })], /read_paths must be an array/);
  assert.throws(() => validatePlan({ tasks: [] }, { cwd: project, mode: "workspace-write" }), /no tasks/);
  assert.throws(() => validatePlan([], { cwd: project, mode: "workspace-write" }), /must be a JSON object/);
  assert.throws(() => validatePlan({}, { cwd: project, mode: "workspace-write" }), /"tasks" array/);
  console.log("ok - schema, unique ids, dependency existence and acyclicity are enforced");

  // --- path rules ----------------------------------------------------------
  rejects([base({ read_paths: ["../etc"] })], /escapes the workflow cwd/);
  rejects([base({ write_paths: ["src/../../etc"] })], /escapes the workflow cwd/);
  rejects([base({ read_paths: ["/etc/passwd"] })], /must be relative/);
  rejects([base({ write_paths: ["C:/Windows"] })], /must be relative/);
  rejects([base({ write_paths: ["src\\..\\..\\etc"] })], /escapes the workflow cwd/);
  rejects([base({ write_paths: [".git/config"] })], /protected directory ".git"/);
  rejects([base({ read_paths: ["node_modules/left-pad"] })], /protected directory "node_modules"/);
  rejects([base({ write_paths: ["."] })], /whole cwd as a write path/);
  // The symlink escape: declared inside, resolving outside.
  rejects([base({ read_paths: ["escape-link"] })], /resolves outside the workflow cwd via a symlink/);
  rejects([base({ write_paths: ["escape-link/new.txt"] })], /resolves outside the workflow cwd via a symlink/);
  // Paths inside are normalised rather than rejected.
  const okPaths = validate([base({ read_paths: ["./src/", "src/index.js"], write_paths: ["src/new.js"] })]);
  assert.deepEqual(okPaths.tasks[0].read_paths, ["src", "src/index.js"]);
  assert.deepEqual(okPaths.tasks[0].write_paths, ["src/new.js"]);
  // A not-yet-existing file inside the cwd is legitimate.
  validate([base({ write_paths: ["src/brand/new-file.js"] })]);
  console.log("ok - traversal, absolute paths, protected dirs and symlink escapes are rejected");

  // --- fail-closed symlink resolution --------------------------------------
  // A dangling symlink must be refused, not silently skipped as if absent.
  rejects([base({ read_paths: ["dangling.js"] })], /unusable symlink/);
  rejects([base({ write_paths: ["dangling.js"] })], /unusable symlink/);
  // Writing "through" a dangling link resolves to nothing real and is refused.
  rejects([base({ write_paths: ["dangling.js/inner.txt"] })], /unusable symlink/);
  console.log("ok - dangling symlinks are refused rather than treated as absent");

  // --- internal symlink aliases --------------------------------------------
  // alias.js and src/real.js are the same file, so they must conflict.
  const aliasPlan = validate([
    base({ id: "a", task: "write via alias", read_paths: [], write_paths: ["alias.js"] }),
    base({ id: "b", task: "write the real file", read_paths: [], write_paths: ["src/real.js"] }),
  ]);
  assert.deepEqual(
    feasibleBatch(aliasPlan, { done: new Set(), failed: new Set(), started: new Set() }).compatible.map(
      (task) => task.id,
    ),
    ["a"],
    "an internal symlink alias and its real target must serialise",
  );
  console.log("ok - internal symlink aliases conflict by canonical target, not by name");

  // --- allowed_paths scope --------------------------------------------------
  assert.deepEqual(normaliseAllowedPaths(undefined), ["."], "an absent scope means the whole cwd");
  assert.deepEqual(normaliseAllowedPaths(["./src/", "src"]), ["src"], "the scope is normalised and de-duplicated");
  assert.throws(() => normaliseAllowedPaths([]), /allowed_paths is empty/);
  assert.throws(() => normaliseAllowedPaths(["../up"]), /must not contain "\.\."/);
  assert.throws(() => normaliseAllowedPaths(["/abs"]), /must be relative/);
  assert.throws(() => normaliseAllowedPaths(["src/*"]), /unsupported glob/);

  // Containment is one-directional: allowed ["src/a"] must NOT admit "src".
  assert.equal(isWithin("src/a/deep", "src/a"), true, "a nested declared path is inside the scope");
  assert.equal(isWithin("src", "src/a"), false, "a parent of the scope is NOT inside it");
  assert.equal(isWithin("src/a", "."), true, "the root scope contains everything");

  // Writes outside the scope are rejected; reads are bounded by the cwd instead,
  // because a planner has to look at a definition before it can scope the task
  // that touches it.
  rejects([base({ write_paths: ["docs/x.md"] })], /outside allowed_paths/, "workspace-write", ["src"]);
  const wideRead = validate([base({ read_paths: ["docs"] })], "workspace-write", ["src"]);
  assert.deepEqual(wideRead.tasks[0].read_paths, ["docs"], "a read outside the write scope is allowed");
  rejects([base({ read_paths: ["../outside"] })], /escapes the workflow cwd/, "workspace-write", ["src"]);
  // The allowed=['src/a'] vs declared 'src' case is the reason containment is
  // one-directional: a symmetric overlap would wrongly admit it.
  rejects([base({ write_paths: ["src"] })], /outside allowed_paths/, "workspace-write", ["src/a"]);
  // A declared path inside the scope is accepted.
  const scoped = validate([base({ write_paths: ["src/a/new.js"] })], "workspace-write", ["src/a"]);
  assert.deepEqual(scoped.allowed_paths, ["src/a"]);
  assert.deepEqual(scoped.tasks[0].write_paths, ["src/a/new.js"]);
  console.log("ok - writes stay inside allowed_paths while reads are bounded by the cwd");

  // --- credential files are refused on both sides ---------------------------
  // Reads are no longer confined to the caller's grant, so the names that would
  // hand a worker a secret are refused outright.
  for (const secret of [".env", ".env.secrets", "config/app.pem", "deploy/id_rsa", "credentials"]) {
    rejects([base({ read_paths: [secret] })], /credential file/, "workspace-write", ["."]);
    rejects([base({ write_paths: [secret] })], /credential file/, "workspace-write", ["."]);
  }
  // Templates carry no real values, so they stay usable.
  const example = validate([base({ read_paths: [".env.example"] })], "workspace-write", ["."]);
  assert.deepEqual(example.tasks[0].read_paths, [".env.example"], "an example env file is not a credential");
  console.log("ok - credential files are refused in reads and writes alike");

  // --- allowed scope is canonical, not just lexical -------------------------
  // The scope is a grant over files, not over names. `allowed/alias` is inside
  // the allowed subtree lexically, but it points at ../other, so honouring it
  // would grant everything under other/ that the caller never allowed.
  mkdirSync(join(project, "allowed", "sub"), { recursive: true });
  mkdirSync(join(project, "other", "x"), { recursive: true });
  symlinkSync(join(project, "other"), join(project, "allowed", "alias"));

  rejects(
    [base({ write_paths: ["allowed/alias/x"] })],
    /canonical target .* is outside allowed_paths/,
    "workspace-write",
    ["allowed"],
  );
  // The same alias on the read side resolves to other/, which is inside the cwd,
  // so it is allowed: reads are bounded by the working directory, not by the
  // write grant. Containment in the cwd is still proven, symlink and all.
  const aliasRead = validate([base({ read_paths: ["allowed/alias/x"] })], "workspace-write", ["allowed"]);
  assert.deepEqual(aliasRead.tasks[0].read_paths, ["allowed/alias/x"], "a read through an internal alias is allowed");
  rejects(
    [base({ write_paths: ["allowed/alias"] })],
    /canonical target .* is outside allowed_paths/,
    "workspace-write",
    ["allowed"],
  );
  // A genuinely inside path is still accepted, and its canonical scope is kept.
  const insideAllowed = validate([base({ write_paths: ["allowed/sub/new.js"] })], "workspace-write", ["allowed"]);
  assert.deepEqual(
    insideAllowed.allowed_scopes.map((scope) => scope.path),
    ["allowed"],
    "the canonical scope list is reported alongside the lexical one",
  );
  assert.ok(
    insideAllowed.tasks[0].write_canonical[0].startsWith(insideAllowed.allowed_scopes[0].canonical),
    "an accepted write is canonically inside the allowed scope",
  );
  // An allowed path that is itself an escaping symlink is a scope error, and it
  // is reported before any task is inspected.
  symlinkSync(join(outside), join(project, "escaping"));
  rejects(
    [base({ write_paths: ["escaping/x"] })],
    /resolves outside the workflow cwd/,
    "workspace-write",
    ["escaping"],
  );
  console.log("ok - allowed scope is resolved to canonical targets, closing the alias escape");

  // --- acceptance must never silently become null --------------------------
  assert.throws(() => validate([base({ acceptance: "" })]), /acceptance must not be an empty string/);
  assert.throws(() => validate([base({ acceptance: 42 })]), /acceptance must be/);
  assert.throws(() => validate([base({ acceptance: [] })]), /acceptance must not be an empty array/);
  const arrayAcceptance = validate([
    base({ acceptance: ["the file exists", "npm test exits 0"] }),
  ]);
  assert.equal(arrayAcceptance.tasks[0].acceptance, "the file exists; npm test exits 0");
  assert.equal(validate([base({})]).tasks[0].acceptance, null, "an omitted acceptance stays null");
  console.log("ok - acceptance is a non-empty string or a normalised array, never dropped");

  // --- pre-dispatch re-validation ------------------------------------------
  // A path that is inside the cwd at validation time must be re-proved before
  // dispatch, because the filesystem can change in between.
  const recheck = validate([base({ write_paths: ["src/new.js"] })]);
  assertPlanStillContained(recheck);
  const escaped = validate([base({ write_paths: ["src/new.js"] })]);
  // Repoint "src/new.js" at an external directory after validation.
  rmSync(join(project, "src", "new.js"), { force: true });
  mkdirSync(join(outside, "hijack"), { recursive: true });
  symlinkSync(join(outside, "hijack"), join(project, "src", "new.js"));
  assert.throws(() => assertPlanStillContained(escaped), /resolves outside the workflow cwd/);
  rmSync(join(project, "src", "new.js"), { force: true });
  console.log("ok - scope is re-proved against the live filesystem before dispatch");

  // --- a drifted canonical target fails closed ------------------------------
  // A path can stay *inside* the cwd while ceasing to name the same file. The
  // conflict checks use the canonical paths recorded at validation time, so a
  // silent retarget would let two "disjoint" tasks meet on one file. Recomputing
  // the canonical value and comparing it is what catches that.
  mkdirSync(join(project, "dir-a"), { recursive: true });
  mkdirSync(join(project, "dir-b"), { recursive: true });
  symlinkSync(join(project, "dir-a"), join(project, "retarget"));
  const stalePlan = validate([
    base({ id: "s1", task: "write through the link", read_paths: [], write_paths: ["retarget/out.txt"] }),
    base({ id: "s2", task: "write dir-b", read_paths: [], write_paths: ["dir-b"] }),
  ]);
  // At validation time the two tasks were provably disjoint...
  assert.equal(tasksConflict(stalePlan.tasks[0], stalePlan.tasks[1]), false);
  // ...and an output the first task has not created yet keeps the same absolute
  // path when it appears, so a normal plan stays dispatchable.
  writeFileSync(join(project, "dir-a", "out.txt"), "created by an earlier task\n");
  assertPlanStillContained(stalePlan);
  // Repointing the link at dir-b makes the recorded canonical value a lie.
  rmSync(join(project, "retarget"));
  symlinkSync(join(project, "dir-b"), join(project, "retarget"));
  assert.throws(
    () => assertPlanStillContained(stalePlan),
    /no longer resolves to the file the plan was validated against/,
    "a retargeted path must reject the whole plan, not be silently re-resolved",
  );
  // A path that has become a dangling link is refused as unusable, not as absent.
  rmSync(join(project, "retarget"));
  symlinkSync(join(project, "nowhere-at-all"), join(project, "retarget"));
  assert.throws(() => assertPlanStillContained(stalePlan), /unusable symlink/);
  rmSync(join(project, "retarget"), { force: true });
  console.log("ok - a path that no longer resolves to its validated target fails the plan closed");

  // --- read-only mode ------------------------------------------------------
  rejects([base({ write_paths: ["src/x.js"] })], /mode is read-only/, "read-only");
  const readOnly = validate([base({ read_paths: ["src"] })], "read-only");
  assert.deepEqual(readOnly.tasks[0].write_paths, []);
  assert.equal(readOnly.mode, "read-only");
  console.log("ok - read-only mode rejects every write declaration");

  // --- overlap semantics ---------------------------------------------------
  // "." is the root of the cwd: it must contain, and overlap, every subpath in
  // BOTH argument orders. A one-sided comparison silently let a whole-cwd task
  // run next to a task writing underneath it.
  assert.equal(pathsOverlap(".", "src/file"), true, "root must contain a child path");
  assert.equal(pathsOverlap("src/file", "."), true, "child path must be contained by root");
  assert.equal(pathsOverlap(".", "."), true);
  assert.equal(pathsOverlap("src", "src/index.js"), true, "parent/child must overlap");
  assert.equal(pathsOverlap("src/index.js", "src"), true, "child/parent must overlap");
  assert.equal(pathsOverlap("src", "src2"), false, "prefix without a boundary must not overlap");
  assert.equal(pathsOverlap("src/a", "src/a"), true);
  assert.equal(
    tasksConflict(
      { read_paths: [], write_paths: ["."] },
      { read_paths: [], write_paths: ["src/a"] },
    ),
    true,
    "a whole-cwd writer must conflict with a nested writer",
  );

  const writer = { read_paths: ["docs"], write_paths: ["src"] };
  const otherWriter = { read_paths: [], write_paths: ["src/lib"] };
  const reader = { read_paths: ["src/index.js"], write_paths: [] };
  const siblingWriter = { read_paths: [], write_paths: ["docs/other.md"] };
  assert.equal(tasksConflict(writer, otherWriter), true, "write/write in nested dirs must conflict");
  assert.equal(tasksConflict(writer, reader), true, "read/write must conflict");
  assert.equal(tasksConflict(reader, writer), true, "conflict must be symmetric");
  assert.equal(tasksConflict(writer, siblingWriter), true, "a write inside a read root must conflict");
  assert.equal(
    tasksConflict(
      { read_paths: ["src"], write_paths: ["src"] },
      { read_paths: [], write_paths: ["docs"] },
    ),
    false,
    "disjoint writes must not conflict",
  );
  assert.equal(
    tasksConflict({ read_paths: ["src"], write_paths: [] }, { read_paths: ["src/deep"], write_paths: [] }),
    false,
    "read/read overlap must be allowed",
  );
  console.log("ok - overlap treats parent/child as conflicting and read/read as safe");

  // --- readiness and batching ---------------------------------------------
  const plan = validate([
    base({ id: "a", task: "first", write_paths: ["src/a"] }),
    base({ id: "b", task: "second", write_paths: ["docs/b"] }),
    base({ id: "c", task: "third", depends_on: ["a"], write_paths: ["src/c"] }),
    base({ id: "d", task: "fourth", read_paths: ["README.md"], write_paths: [] }),
  ]);

  const fresh = { done: new Set(), failed: new Set(), started: new Set() };
  const firstBatch = feasibleBatch(plan, fresh);
  assert.deepEqual(
    firstBatch.compatible.map((task) => task.id),
    ["a", "b", "d"],
    "independent tasks must all be feasible together",
  );
  assert.deepEqual(
    firstBatch.options.map((batch) => batch.length),
    [1, 2, 3],
    "candidate sizes must span 1..N dynamically, never a fixed cap",
  );

  // A read of a directory another task writes to is a conflict too.
  const readVsWrite = validate([
    base({ id: "w", task: "write docs", write_paths: ["docs/guide.md"] }),
    base({ id: "r", task: "read docs", read_paths: ["docs"] }),
  ]);
  assert.deepEqual(
    feasibleBatch(readVsWrite, fresh).compatible.map((task) => task.id),
    ["w"],
    "a directory read conflicts with a write inside it",
  );

  // c is gated on a; once a is done it becomes feasible.
  const afterA = { done: new Set(["a"]), failed: new Set(), started: new Set(["a", "b", "d"]) };
  assert.deepEqual(
    feasibleBatch(plan, afterA).compatible.map((task) => task.id),
    ["c"],
  );

  // A failed dependency removes downstream work from readiness entirely.
  const afterFail = { done: new Set(), failed: new Set(["a"]), started: new Set(["a", "b", "d"]) };
  assert.deepEqual(feasibleBatch(plan, afterFail).compatible, []);
  assert.ok(unreachable(plan, afterFail).has("c"), "a failed dependency must block its dependent");
  console.log("ok - readiness honours dependencies and dynamic candidate sizes");

  // Write-conflicting tasks are never offered as one batch.
  const conflicting = validate([
    base({ id: "w1", task: "write one", write_paths: ["src/shared"] }),
    base({ id: "w2", task: "write two", write_paths: ["src/shared/deep"] }),
  ]);
  const conflictBatch = feasibleBatch(conflicting, fresh);
  assert.deepEqual(
    conflictBatch.compatible.map((task) => task.id),
    ["w1"],
    "overlapping writers must serialise",
  );
  assert.equal(conflictBatch.ready.length, 2, "both stay ready, just not concurrently");
  console.log("ok - write-conflicting tasks are never batched together");

  // --- evidence grading ----------------------------------------------------
  const goodJob = { exit_code: 0, status: "done" };
  const good = gradeJob(goodJob, {
    status: "done",
    answer: JSON.stringify({
      outcome: "success",
      summary: "did it",
      changed_files: ["src/x.js"],
      checks: [{ command: "npm test", exit_code: 0 }],
      artifacts: [],
      issues: [],
    }),
  });
  assert.equal(good.ok, true);
  assert.equal(good.report.changed_files[0], "src/x.js");
  assert.equal(good.report.checks[0].exit_code, 0);

  // Exit 0 with no report is NOT a pass.
  const silent = gradeJob(goodJob, { status: "done", answer: "" });
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /no parseable evidence report/);

  // A success claim from a crashed worker is NOT a pass.
  const crashed = gradeJob(
    { exit_code: 1, status: "failed" },
    { status: "failed", answer: JSON.stringify({ outcome: "success", summary: "claimed", checks: [] }) },
  );
  assert.equal(crashed.ok, false);
  assert.match(crashed.reason, /ended as failed/);

  // An explicit failure is honoured.
  const failedReport = gradeJob(goodJob, {
    status: "done",
    answer: JSON.stringify({ outcome: "failed", summary: "broke", issues: ["x"] }),
  });
  assert.equal(failedReport.ok, false);
  assert.equal(failedReport.outcome, "failed");

  // Prose before the report is tolerated; the last balanced object wins.
  const chatty = parseEvidence('Here is my report:\n{"outcome":"blocked","summary":"need input"}\nthanks');
  assert.equal(chatty.outcome, "blocked");
  assert.equal(parseEvidence('{"outcome":"maybe"}').outcome, "unknown");
  console.log("ok - only a valid success report releases dependents");

  console.log("all plan and evidence checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
