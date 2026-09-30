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
  +-> planning     ONE read-only DSH worker (startJob), only when decompose=true
  |                  or when synthesis has no honest write scope to offer
  |                  prompt demands a bare JSON plan, no delegation, no edits
  |                  skipped by default: p50 155s, p90 387s of serial latency,
  |                  for a plan that held one task 80% of the time
  |
  +-> judging      acquirePlan() -> validatePlan()      src/plan.mjs
  |                  synthesised plans go through the identical validator
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

## How a plan is obtained

`acquirePlan` has two branches, and the default is the one that starts no
process at all.

**Code-synthesised (the default, `decompose` not true).** `synthesisePlan` builds a
one-task plan from the caller's own request: the objective becomes the task text
verbatim, `read_paths` is the allowed scope, and `write_paths` is that scope minus
any bare `"."`. The result is handed to `validatePlan` exactly like a planner's,
so the mode, scope, credential and containment rules are unchanged and this path
cannot authorise anything a planner could not. It is not a bypass, only a
shortcut.

**Planner (when `decompose: true`, or when synthesis would be dishonest).** The one
case that plans on its own is a `workspace-write` workflow whose `allowed_paths` is
the bare `"."` default: `validatePlan` refuses a task that declares the whole cwd as
its write path, and without reconnaissance there is no honest subpath to name.
Returning `null` there, with the reason, is what routes that workflow to the
planner instead of producing a plan that would be rejected.

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

The prompt also states an investigation budget: at most 10 bounded file reads and
15 tool calls, no full diagnosis or test runs, and no session-log, history, or
whole-repo sweeps. That budget is instruction-only — no code counts steps or tool
calls — while the enforced backstop is the planning wall-clock deadline,
`DEFAULT_PLANNING_TIMEOUT_MS` (10 minutes), which cuts off a planner that overruns.

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

## ## Waiting is an event, not a poll

Every wait in the bridge used to be the same loop: wake, re-read the job, ask
whether it is still running, sleep 250 ms, repeat. A wait therefore returned on
the first tick *after* the work ended, not when it ended — uniformly up to a
quarter second late, once per hop, and compounding across a workflow's waves and
across a caller's own start-then-wait pairs.

The answer was already an event. A job settles on its child's `close`, which is
where settlement already happens because that is the moment the recorded answer is
complete. A cancellation is recorded when it is requested. A workflow ends in
`settle()`. `settle.mjs` holds a promise per subject, armed when work starts and
released when it ends, and every wait is a race between that signal and its own
deadline.

The deadline cap survives deliberately. It is not a fallback for a missing
signal — it is what still bounds a subject that can only end because the window
closed, and what keeps a cancel or an expired parent deadline re-checked on
time. A subject this process does not own has no signal at all and keeps the old
cadence, because an instantly-resolving promise there would be a hot loop.

Measured over 30 runs of a 137 ms worker, overshoot being the time between the
job's own `ended_at` and the wait returning:

| | mean | median | max |
|---|---|---|---|
| polling | 39.3 ms | 29 ms | 251 ms |
| event-driven | 0.4 ms | 0 ms | 3 ms |

One structural fix came out of this. The workflow success path used to stamp
`ended_at` itself instead of going through `settle()`, so it never released its
waiters and a `dsh_wait` on a workflow that *succeeded* waited out its whole
window. Both endings now go through `settle()`; one place decides a workflow has
ended.

## Reading the snapshot directories

`dsh_list` and `dsh_prune` both read every snapshot in a directory, and both go
through `jobindex.mjs` rather than reading the files themselves. The index keys
each row on the file's mtime and size: a pass `stat`s every entry, reuses the row
for anything unchanged, and reads only what actually moved.

That shape came from measurement, not preference. Over 2,675 job snapshots,
`stat` on all of them costs 5.8 ms, reading them costs 1,802 ms, and the
`JSON.parse` is only ~170 ms of that. The old code re-read every byte on every
call, synchronously, so a 1,400 ms listing blocked the single-threaded server and
a cheap call queued behind it waited the same 1,400 ms. Now the first listing in
a process pays the read off the event loop, every later one is a stat sweep, and
nothing waits behind it.

Three details keep the cache honest:

- **Only the requested fields are kept.** `stdout` and `stderr` are the bulk of
  these files and neither a listing nor a prune needs them, so the cache holds a
  few hundred kilobytes for a few thousand jobs rather than 59 MB.
- **This process invalidates on write and on delete.** `persist` drops the row it
  just rewrote and a prune drops the row it just removed, so a write that lands
  inside the filesystem's mtime resolution still cannot be served stale.
- **A file that is unreadable, corrupt, or gone is skipped**, and its entry is
  dropped, so one bad snapshot never fails a listing.

## Deliberate non-goals

- **No global concurrency ceiling.** Batch size comes from what is actually
  feasible each round; the caller's own machine is the limit.
- **No LLM summarisation of results.** Aggregation is plain code.
- **No path sandbox.** Declared paths are validated; a running worker's actual
  filesystem access is governed by its DSH profile, not by this bridge.
- **No cross-process workflow management.** Only the process that started a
  workflow can wait on or cancel it.

## Round trips and retention

The caller's cost is dominated by how often it asks, not by what DSH does. A
poll is a full request carrying the caller's whole conversation, so the tool
surface is shaped to reduce the number of asks:

- `dsh_start` accepts `wait_for_ms` and returns a finished job inline, removing
  the start-then-poll pair for short work. The window is capped so a long job
  becomes a background job quickly.
- `dsh_wait` defaults to a 240000 ms window, deliberately under the outer
  300-second MCP `tools/call` timeout; a job still running when it closes is
  waited on again with the same window. It still returns the instant a job
  settles, so a long window costs nothing when work finishes early.
- `dsh_wait_any` watches a set and returns on the first finisher, or on the last
  one with `wait_for: "all"`. Parallel dispatch is the bridge's purpose, and a
  per-job wait would reintroduce one polling chain per job.
- `tier` maps a task shape to a deadline. A single flat timeout misfits both a
  question and a build; the tiers are `investigate`, `edit`, and `build`.

`waitJob` in `jobs.mjs` is the single polling implementation behind both
`dsh_wait` and the inline wait, so the settled-check cannot drift between them.

`statusOf` bounds the answer it returns. `MAX_OUTPUT_CHARS` caps what the bridge
retains; `MAX_ANSWER_CHARS` caps what it hands back, because a tool result is
re-sent with every later request in the caller's conversation. An oversized
answer is trimmed, labelled with its true length and omitted count, and
accompanied by the snapshot path that holds it whole; `include_logs` returns it
whole. The workflow reader already had this budget, so the two paths now agree.

`dsh_prune` reports reclaimable state and deletes only under `apply: true`.
Eligibility requires a settled job whose `ended_at` is older than the cutoff and
which is not still running in this process; a workflow's artifact directory goes
with its snapshot, which is why the deletion is opt-in rather than automatic.
