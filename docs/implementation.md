# dsh_delegate implementation

How one `dsh_delegate` call turns an objective into evidence for review, and
where each guarantee is enforced.

## Flow

```
dsh_delegate(task, cwd, mode, allowed_paths, timeout_ms, profile)
  |
  |  startWorkflow()                      src/workflow.mjs
  |    - records the deadline (Date.now() + timeout_ms)
  |    - persists a snapshot, returns the parent job_id immediately
  |
  +-> planning     one read-only DSH worker (startJob)
  |                  prompt demands a bare JSON plan, no delegation, no edits
  |
  +-> judging      parsePlan() -> validatePlan()      src/plan.mjs
  |                  invalid plan => failed, nothing is started
  |
  +-> executing    loop until nothing is ready:
  |                  feasibleBatch()  -> which tasks are safe, and how many options
  |                  choose()         -> TypeSafe picks a count, or serial fallback
  |                  startJob() x N   -> one worker per task
  |                  awaitWorker()    -> gradeJob() decides done/failed/blocked
  |
  +-> awaiting_review
                     aggregate counts + per-task evidence, write artifacts
```

`failed`, `cancelled` and `timed-out` are the other terminal states. The
controller never reports success on the caller's behalf.

## Where each guarantee lives

| Guarantee | Enforced in |
|---|---|
| Plan shape, unique ids, dependencies exist, acyclic | `plan.mjs` `validatePlan` |
| No `..`, absolute paths, `.git`, `node_modules` | `plan.mjs` `normaliseRelativePath` |
| No symlink escape | `plan.mjs` `assertContained` (realpath of the deepest existing ancestor) |
| read-only mode rejects writes | `plan.mjs` `validatePlan` |
| Parent/child and read/write overlap conflicts | `plan.mjs` `pathsOverlap` / `tasksConflict` |
| Dynamic candidate batch sizes (no fixed cap) | `plan.mjs` `feasibleBatch` |
| Dependents blocked by a failed dependency | `plan.mjs` `unreachable`, `computeReady` |
| Only a valid success report releases dependents | `evidence.mjs` `gradeJob` |
| Cancel/deadline checked before every start | `workflow.mjs` `runWorkflow` |
| Serial fallback is recorded, not hidden | `choices.mjs` `decideConcurrency` |
| Settlement waits for stdio to end | `jobs.mjs` `close` handler |

## The planner contract

The planner is one ordinary DSH headless worker, started through the same
`startJob` path as everything else. Its prompt states the objective, the cwd,
the mode, the allowed paths, and these rules: investigate read-only, do not
delegate, split as little as possible, make each task self-contained, and emit
only a JSON object shaped like:

```json
{ "tasks": [ { "id": "...", "task": "...", "read_paths": ["..."],
               "write_paths": ["..."], "depends_on": ["..."],
               "acceptance": "..." } ] }
```

The prompt is a request. `validatePlan` is what makes it binding: a plan that
does not satisfy every rule above fails the workflow. Nothing is "fixed up" and
run anyway, because a silently repaired plan would also silently drop the write
paths that the conflict checks depend on.

## Why TypeSafe only picks a number

By the time TypeSafe is asked anything, code has already decided:

- which tasks are **ready** (dependencies satisfied), and
- which subset of those can run together without overlapping paths.

What remains is a judgment call — how much parallelism is wise right now — and
that is the only thing the model is asked. The candidate labels (`"1"`, `"2"`,
… up to the size of the safe batch) are generated from the plan each round, so
the ceiling moves with the work instead of being a hard-coded constant.

The response is accepted only if its label is one of the offered options.
Anything else — a missing key, a transport error, a label the model invented —
produces a `fallback` decision with `count: 1` and a recorded reason. Every
decision is appended to `workflow.decisions`, so the scheduling history shows
which rounds used a model and which fell back.

With exactly one feasible option the decision is made in code
(`source: "code"`) and no model is called at all.

## Worker evidence

Each task worker is told to end with a single JSON object:

```json
{ "outcome": "success|failed|blocked", "summary": "...",
  "changed_files": ["..."], "checks": [{"command": "...", "exit_code": 0}],
  "artifacts": ["..."], "issues": ["..."] }
```

`gradeJob` requires **both** a zero exit and a `success` outcome. Exit 0 alone
is not completion, and a success claim from a crashed worker is discarded. Only
a graded pass releases dependent tasks; a failure blocks descendants while
independent tasks continue.

`artifacts` and `issues` are evidence, not transcript: the compact record written
to the parent snapshot and to `evidence.json` keeps both arrays whole, and
`include_logs` returns them in full. Only the bounded default read trims them,
and it says so with a count.

## Cancellation and deadlines

`timeout_ms` becomes an absolute `deadline_at` shared by the planner and every
worker (`startJob` receives it and clamps its own timer to it). The loop
re-checks both `cancelled` and `remainingMs()` before each start, so nothing is
launched after a cancel or past the deadline.

`dsh_cancel` on a workflow sets the cancel flag, then requests SIGTERM for each
worker job the parent started that is still live in this process — the planner
while it is still planning, and every task worker still running — all through one
precise-job-id path, with no process scanning. The reply separates
`children_cancel_requested` from `children_not_confirmed`, and states that a
request is not proof of exit and that grandchildren are not signalled. A planner
that is still live is reported in the requested list under `task_id: "planner"`,
so a caller cannot mistake "workflow cancelled" for "the planner stopped".

A judgment already in flight is aborted by the cancel. Because the chooser can
answer only after the workflow has settled, the loop re-checks `cancelled` and
`remainingMs()` **after** `await choose(...)` returns, before anything is
dispatched. A decision that arrived in that window is never recorded as applied:
it is appended to `workflow.decisions` with `discarded: true` and a
`discarded_reason` (`cancelled before dispatch`, or `workflow deadline expired
before dispatch`), and that path persists the snapshot itself, since `settle` is
already a no-op once `ended_at` is set. The evidence therefore shows the judgment
happened and was deliberately not dispatched, instead of reading like a batch
that ran.

## Reading a workflow status

The caller is an agent with a context budget, so the default status read is
bounded, not a log dump. `workflowStatus` caps the number of children, the checks
and changed files per child, the scheduling decisions, and the length of each
string field (`STATUS_LIMITS`). Everything trimmed is reported as an explicit
count — `children_omitted`, `scheduling_omitted`, `checks_omitted`,
`changed_files_omitted` — and `artifact_dir` always names the directory holding
the complete evidence, so nothing is lost, only deferred.

Two properties make the trimming safe to read:

- **Failure-first.** Children are ordered failed, blocked, running, pending,
  done, and only the tail is ever dropped, so a failure cannot be buried by a
  long tail of successes. Within a child, the failing check is kept even when it
  sits past the per-child window.
- **A real cap, not an assumption.** The default payload is measured, and if it
  still exceeds `MAX_CHARS` it is shrunk by dropping the lowest-priority trailing
  children and then the oldest decisions until it fits, with the omission counts
  recomputed each time. `counts`, `artifact_dir` and the failure-first front are
  never dropped.

`includeDetail: true` (exposed on the tools as `include_logs`) is the escape
hatch: it returns every child with full unclipped summaries, reasons, check
commands and changed-file lists, every decision, and the plan — no cap and no
omission keys. It is a different payload for a caller who has asked for the whole
thing, not a bigger window.

## State and restarts

Live workflows exist only in memory. A compact snapshot is written to
`WORKFLOW_ROOT/<job_id>.json`, and full plans, chooser responses and worker
answers go to `WORKFLOW_ROOT/<job_id>/` so the snapshot stays small.

Reading an id that is not in memory returns the snapshot with
`controller_alive: false` and a note saying it cannot be resumed, waited on, or
cancelled. There is no resumption, no process scanning, and no queue: a workflow
whose controller is gone stays gone. Parent snapshots live in a subdirectory of
`JOB_ROOT`, so `dsh_list` can report worker jobs and workflows separately
without double-counting.

## Deliberate non-goals

- **No global concurrency ceiling.** Batch size comes from what is actually
  feasible each round; the caller's own machine is the limit.
- **No LLM summarisation of results.** Aggregation is plain code.
- **No path sandbox.** Declared paths are validated; a running worker's actual
  filesystem access is governed by its DSH profile, not by this bridge.
- **No cross-process workflow management.** Only the process that started a
  workflow can wait on or cancel it.
