# Design

Why this bridge exists, and the shape it settled on. For how the workflow is
actually wired, see [implementation.md](implementation.md).

## Why a bridge is needed

Codex speaks MCP. DSH exposes ACP. The two protocols do not interoperate, and
Codex ships no ACP client, so a direct connection between the two agents is not
possible. Something has to sit in the middle and speak MCP on one side.

That is the whole job of this server:

```
Codex  --(MCP, stdio)-->  dsh-bridge-mcp  --(spawn)-->  dsh --profile headless "<task>"
```

Codex plans and reviews. DSH does the file reading, editing, and checking. The
bridge itself does not think; it spawns, schedules, records, and reports.

The DSH side is deliberately the plain `headless` profile. The CLI contract is
small and stable — answer one task, print the final assistant message, exit with
status 0 — which means the bridge can be written against a process boundary
instead of a session protocol.

## Two layers of delegation

The server offers two levels of control, and they are meant for different
callers:

- **A single job** (`dsh_start` and friends) — the caller decides everything.
  One task in, one worker out, status polled by job id. This is the right layer
  when the caller already knows what it wants run.
- **A whole workflow** (`dsh_delegate`) — the server owns the objective. It
  plans, validates the plan in code, decides how much of it may run at once, runs
  one worker per task, and stops in `awaiting_review` with per-task evidence.

The second layer exists because the interesting failures in delegation are
scheduling failures: overlapping writes, dependency ordering, a plan that quietly
dropped a write path. Those are properties of the plan, so they are checked in
code — see [implementation.md](implementation.md) for where each guarantee lives.

## Design choices worth calling out

**Evidence, not acceptance.** A worker is "done" only when its process exited 0
*and* it reported a structured success. The bridge never reports success on the
caller's behalf, and it never summarises results with a model. `awaiting_review`
means exactly that.

**Validation is binding, not advisory.** The planner prompt states the rules, but
`validatePlan` is what enforces them. A plan that breaks a rule fails the
workflow; it is never repaired and run anyway.

**The model picks a number, nothing else.** By the time TypeSafe is asked
anything, code has already decided which tasks are ready and which subset can run
together. All that is left is how much parallelism is wise right now, so that is
the only question asked. Any answer that is not one of the offered options is
recorded as a serial fallback — the bridge degrades to one task at a time rather
than guessing.

**Bounded status by default.** The caller is an agent with a context budget, not
a log viewer, so the default status read is trimmed and says what it trimmed. The
unbounded view stays available on request, and the artifact directory always
holds everything.

**Honest reporting of what was *not* done.** Cancels report which stop requests
were made and which were not confirmed. A judgment that answers after a cancel is
recorded as discarded rather than applied. A workflow whose controller is gone is
reported as not live. None of these paths are allowed to look like success.

## Known boundaries

- **Path validation is not an OS sandbox.** Declared paths are checked; what a
  running worker actually touches is governed by its DSH profile.
- **Concurrency is limited by declared paths.** Accurate declarations are what
  make parallel execution safe.
- **No global concurrency ceiling.** Batch size comes from what is feasible each
  round; the caller's machine is the limit.
- **Only the process that started a workflow can control it.** There is no queue,
  no cross-process resumption, and no process scanning.

The full list, with rationale, is in the [README](../README.md#known-limitations).
