# dsh-bridge-mcp

MCP server that lets **Codex delegate coding tasks to DeepSeek Harness (DSH)**.

Codex plans and reviews; DSH does the file reading, editing, and checking.

-----

## Why this exists

Codex speaks MCP. DSH exposes ACP. The two protocols do not interoperate, and
Codex has no ACP client, so a bridge is required. This server is that bridge: it
speaks MCP to Codex and drives `dsh --profile headless` underneath.

Inspired by [`deepseek-claude-code-worker-mcp`](https://github.com/louchi1984-coder/deepseek-claude-code-worker-mcp)
(MIT), which does the same for Claude Code; this is the DSH equivalent.

-----

## Install

Requires **Node.js >= 20.12.0** (the credential loader uses `util.parseEnv`).

```sh
cd /absolute/path/to/dsh-bridge-mcp
npm install
```

Register with Codex:

```sh
codex mcp add dsh-bridge -- node /absolute/path/to/dsh-bridge-mcp/bin/dsh-bridge-mcp.mjs
```

Then add one config key, or delegation will be refused with
`MCP tool call requires approval, but approval policy is never`:

```toml
[mcp_servers.dsh-bridge]
command = "node"
args = ["/absolute/path/to/dsh-bridge-mcp/bin/dsh-bridge-mcp.mjs"]
default_tools_approval_mode = "approve"
```

See [docs/codex-setup.md](docs/codex-setup.md) for why this is required and how
to scope it per tool.

Verify the registration:

```sh
codex mcp list | grep dsh-bridge
```

-----

## Tools

| Tool | Purpose |
|---|---|
| `dsh_delegate` | **Run a whole managed workflow**: plan, judge concurrency, execute, report evidence |
| `dsh_start` | Delegate one task; returns a `job_id` immediately |
| `dsh_get` | Compact status + final answer (worker job **or** workflow); a read, not a poll |
| `dsh_wait` | Block until settled, bounded window; returns the full status |
| `dsh_wait_any` | Watch several jobs with one call; returns each finisher's full status |
| `dsh_tail` | Output tail for debugging |
| `dsh_cancel` | Stop a running job or a whole workflow |
| `dsh_list` | List known jobs and workflows |
| `dsh_prune` | Report, and optionally delete, finished bridge state |

Route by shape: a single clear objective — even one that spans several files or
needs code reading — belongs to `dsh_start` with `wait_for_ms`. Reach for
`dsh_delegate` only when the request genuinely contains independent subtasks that
need dependency or parallel orchestration.

### `dsh_delegate` — the managed workflow

One call owns a complete objective. It builds the plan, validates it **in code**,
asks TypeSafe how many safe tasks to start at once, runs one DSH worker per task,
and finishes in `awaiting_review`.

**By default no planning worker is started.** The plan is built in code from what
the caller already passed — the objective, the mode and the allowed paths — as a
single task. The planner is a whole DSH run whose only output is a JSON plan, so
starting one is a full extra *serial* round trip in front of the work. Measured
over 672 recorded planners: **p50 155 s, p90 387 s**, indistinguishable from an
ordinary worker job (p50 154 s), and 35.8 hours of compute spent in total. A live
trivial read-only objective spent 19.1 s of its 35.1 s (54%) planning. That cost
bought little: **477 of 595 recorded plans (80.2%) held a single task**, 106
workflows produced no task at all, and 251 (37%) produced no successful task.
After this change the same workflow finished in 16.0 s.

Pass `decompose=true` to plan first. One case still plans on its own: a
`workspace-write` workflow whose `allowed_paths` is the bare `"."` default, because
`validatePlan` refuses a task that declares the whole cwd as its write path and
there is no honest subpath without reconnaissance. The status read reports which
path was taken through `plan_source` (`"code"` or `"planner"`).

The asymmetry is deliberate. Leaving `decompose` off for an objective that really
did need splitting is recoverable — one worker does the work serially, exactly as
`dsh_start` would — whereas the reverse spends 155 s on a plan that says "one
task". It is a caller decision rather than a guess made here, because the split is
not lexically detectable: the one-task rate was 70/86/81/78% across the four
objective-length buckets, and no lexical signal recovered both halves of it.

When a planner *is* started it carries an instruction-only investigation budget:
the prompt asks for at most 10 bounded file reads and 15 tool calls, and nothing
in the code counts them. The enforced backstop is a 10-minute planning wall-clock
deadline (`DEFAULT_PLANNING_TIMEOUT_MS`), which cuts off a planner that overruns.

```
dsh_delegate(
  task="Add input validation to src/api.ts and cover it with tests",
  cwd="/repo",                       # required, absolute
  mode="workspace-write",            # or "read-only"
  allowed_paths=["src", "tests"],    # optional, relative to cwd; default project root
  timeout_ms=3600000,                # total deadline for planning + all tasks
  decompose=false)                   # true = plan with an extra DSH worker first
  -> { job_id: "...", kind: "workflow", status: "executing" }
```

Phases: `planning` -> `judging` -> `executing` -> `awaiting_review`
(failure paths: `failed`, `cancelled`, `timed-out`).

`dsh_get` on that id returns counts, phase, per-task evidence and child job ids —
not the full transcripts, which are written to an artifact directory.

**`awaiting_review` is not acceptance.** Every worker must end with a JSON
evidence report; a task is "done" only when the process exited 0 *and* the report
claims success. That evidence is what you verify — nothing here proves the work
is correct.

### Typical flow

```
dsh_start(task="Add input validation to src/api.ts and run the tests",
          cwd="/repo", wait_for_ms=5000, tier="edit")
  -> { status: "done", answer: "...", returned_inline: true }

dsh_delegate(task="...", cwd="/repo", mode="workspace-write", tier="build")
  -> { job_id: "..." }
dsh_wait(job_id="...", max_wait_ms=240000)
  -> { status: "awaiting_review", counts: {...}, children: [...] }
```

### Keeping the round trips down

Every poll is a full request from the calling agent, carrying its whole
conversation, so polling — not the delegated work — tends to dominate the
caller's token cost. Three parameters exist for that reason:

- **`wait_for_ms` on `dsh_start`** holds the call open briefly and returns the
  finished result inline. Short jobs are the common case, and this collapses the
  usual start-then-poll pair into one round trip.
- **`max_wait_ms` on `dsh_wait`** defaults to 240000, deliberately under the outer
  300 s MCP `tools/call` timeout. A job still running when the window closes is
  waited on again with the same window; an explicit `max_wait_ms` still overrides
  it, and the call returns the moment the job settles.
- **`dsh_wait_any`** watches a whole parallel set with one call. Without it, N
  parallel jobs cost N polling chains to learn the same thing.

Waiting also returns everything, so collecting a result is never a second call:
`dsh_wait` and `dsh_wait_any` both hand back the same full status `dsh_get`
would, answer and failure reason included. `dsh_get` is for re-reading a job you
stopped waiting on, or for recovering a trimmed answer with `include_logs=true`.
When several jobs settle in one `dsh_wait_any` window they share a 48000-character
answer budget, split evenly so one talkative worker cannot crowd out the rest;
each trimmed answer still carries its `answer_path`. A 64000-character ceiling
backs that up, since a settled *workflow* returns a whole status that no answer
budget bounds: entries past it are listed as ids under `settled_summarised`,
failures first in the full list so the ceiling can only drop finished work.

This was measured, not assumed. Over the quota window that began 2026-09-20, 181
of 1114 `dsh_get` calls directly followed a `dsh_wait_any` that had returned only
a status, and the conversation those extra round trips re-sent was 142k tokens at
the median — far more than the few thousand characters being fetched.

**`tier`** picks a deadline by task shape — `investigate` (5m), `edit` (15m),
`build` (30m) for a worker, and 20m / 1h / 2h for a whole workflow — instead of
one flat timeout that is simultaneously too long for a question and too short for
a build. An explicit `timeout_ms` always wins.

### Bounded answers

A tool result enters the caller's conversation and is re-sent with every later
request, so a worker's answer is trimmed to 12000 characters by default. The
reply then carries `answer_truncated`, the true `answer_chars`, the
`answer_omitted` count, and `answer_path` — the job snapshot holding the whole
text. Nothing is lost: `include_logs=true` returns the answer in full. This
matches the budget the workflow reader already applied, so both paths behave the
same way.


### Lean replies

Every reply is compact JSON, and a field earns its place by telling the caller
something: the `cwd` it passed is not echoed back, and `truncated` /
`answer_truncated` appear only when true. Measured on 1,354 real job snapshots,
that cut the default read by 6.0%; most of what remains is the answer itself.

DSH headless streams the worker's reasoning to stderr, and that reasoning never
enters a reply. What a caller does need from stderr is the reason a job failed —
a single `dsh: CODE: message` line such as `RATE_LIMIT: 429` — and that is
returned by default as `diagnostics`, so learning why a job failed takes no
extra read. The bridge keeps the *end* of stderr, since the diagnostic comes
after the reasoning. `include_logs=true` now means the whole answer (or a
workflow's full detail) and nothing else, which cut those reads by 27.5%.
`dsh_tail` is where the reasoning is read — the only sign of progress while a
job runs — and caps each stream at 8000 characters. `dsh_list` returns 20 rows
per list by default (`limit`, up to 50); its counts cover everything.

Listing and pruning read the snapshot directories through a shared index
(`jobindex.mjs`) keyed by each file's mtime and size. A listing `stat`s every
entry, reuses the row for anything unchanged, and reads only what actually moved;
the same index serves a prune, which was paying the identical cost on every dry
run. Both run off the event loop, so a listing can no longer stall the
single-threaded server behind it. Measured on this machine over 2,675 job
snapshots: `stat` on all of them costs 5.8 ms, reading them costs 1,802 ms, and
the parse only ~170 ms of that — the cost was the I/O, and none of it changes
unless the file does. A `dsh_list` that used to block for 1,400 ms every call
now costs ~350 ms on the first call in a process and ~18 ms on every later one,
and a cheap call queued behind it no longer waits at all.

The write side had the same shape of problem. stdout arrives in as many chunks
as the child happens to write, and each chunk used to rewrite the whole snapshot
synchronously, so a streaming worker cost a write per chunk and each write grew
with the answer — an 80 KB answer delivered in 40 chunks wrote ~1.6 MB, 21x the
answer, blocking the single-threaded server on every one. Writes while a job is
still running are now bounded to one per 250 ms, so the cost stops depending on
how a worker chunks its output. Settling always writes through immediately, so a
finished job is still complete on disk: measured, a 60-chunk stream costs 2
snapshot writes instead of 60, and 200 chunks cost 6 instead of 200, with the
answer intact and `truncated` still false in both cases.

### What the descriptions cost

Nine tool descriptions are re-sent with **every** request, so their cost scales
with conversation length rather than with how often a tool is actually used. That
makes them the one part of this bridge where an extra sentence has a permanent
price, and it is a price nothing else reports: no test fails when it is paid.

So one does. `tests/schema-budget.mjs` sums every description and input schema
and fails past a budget, and prints the split so the growth is visible when it
happens. The rule applied when the descriptions were cut was to keep what changes
what a caller does and cut what only explains why the bridge is built that way:
defaults, caps, enums, `awaiting_review` not being acceptance, `mode` not
narrowing a profile's network tools, and the fact that a bare `"."` cannot be a
workspace-write scope all stayed. Measured history, architecture narrative and
restated rationale went.

| | chars | ~tokens |
|---|---|---|
| before | 10,279 | 2,570 |
| after | 8,138 | 2,035 |

Of the remaining total, ~3,000 chars are JSON structure — types, enums,
`required`, `additionalProperties`, and the `$schema` URL the SDK adds — which
is what the tools need to be validated at all.

### Waiting

`dsh_wait` and `dsh_wait_any` used to poll on a 250 ms cadence, so a wait came
back up to a quarter second *after* the work it was waiting for had actually
finished — once per hop. Settlement is an event, so waits now end with the work:
a job settles on its child's `close`, a cancellation is recorded when it is
requested, and a workflow ends in one place that both its success and failure
paths go through. Measured over 30 runs of a 137 ms worker, the gap between the
job's own `ended_at` and the wait returning fell from a 39 ms mean (max 251 ms) to
0.4 ms (max 3 ms). The deadline cap is still there, because a wait on something
this process does not own can only end when the window closes.

### Reclaiming disk

Every delegation leaves a snapshot, and a workflow also leaves an artifact
directory, because evidence has to outlive the controller for acceptance to be
possible. `dsh_prune` reports what is reclaimable and deletes only when you pass
`apply=true`; jobs still running are never candidates, and it touches only this
bridge's own state — never a project's files, and never DSH's session history.

-----

## Scheduling and safety rules

These are enforced by code, not by prompt, so a model cannot relax them:

- **Plan validation.** The planner's JSON must parse; task ids must be unique;
  dependencies must exist and be acyclic; a read-only workflow rejects any plan
  declaring a write path. `acceptance` must be a non-empty string or an array of
  them — it is never silently dropped. An invalid plan fails the workflow — it is
  never "repaired" and executed.
- **Path containment.** Every declared path is resolved against the real cwd,
  including symlink resolution, and rejected if it escapes. Only `ENOENT` is
  walked upward while resolving; a dangling symlink, an unresolvable link, or a
  permission error is a rejection, never a skip. `..`, absolute paths, `.git`
  and `node_modules` are rejected outright. Containment is re-proved immediately
  before dispatch, because the filesystem can change after planning. This is a
  lexical/realpath check, not an OS sandbox.
- **Allowed scope.** `allowed_paths` is enforced in code, not just stated in the
  prompt: every declared read/write path must sit *inside* an allowed path
  (one-directional — allowed `src/a` does not admit a declared `src`). An
  omitted value means the whole cwd (`["."]`); an explicit empty array is
  rejected. The caller's `cwd`, `mode` and `allowed_paths` are validated before
  the planner ever starts.
- **Concurrency.** Two tasks never run together if their paths overlap, unless
  both only *read* them. Parent/child directory overlap counts in both
  directions, and `.` (the whole cwd) overlaps everything. Paths are compared by
  their canonical target, so a symlink alias and its real file conflict rather
  than appearing independent. The feasible batch size is computed from the plan
  each round; TypeSafe only chooses *how many* of the already-safe options to
  start, and its Choice labels are built from that number — never a fixed 2/4/6.
- **Dependencies.** A task starts only after every dependency produced valid
  success evidence. A failure blocks dependents; unrelated tasks continue.
- **Deadlines and cancellation.** One `timeout_ms` bounds planning and every
  task. No worker is started after the deadline or after a cancel, and both are
  re-checked after the concurrency judgment. A cancel or an expired deadline
  also aborts an in-flight TypeSafe call instead of waiting out the HTTP
  timeout. A cancel during judgment never records the decision as executed and
  never starts another worker.

### TypeSafe

TypeSafe is asked exactly one narrow question per scheduling round. If no key is
configured, the call fails, or the answer is not one of the offered options,
the bridge falls back to **serial** and records that fallback in the workflow's
decision log. It does not retry (the SDK is configured with `maxRetries: 0`), and
it never treats `confidence` as a correctness guarantee.

Failures are recorded as a fixed category plus, when available, a numeric HTTP
status (`auth_rejected`, `rate_limited`, `upstream_unavailable`, `call_error`,
`aborted`, ...). The raw SDK message, response body and the model's raw choice
label are never returned or logged, because they can carry credentials.

| Env var | Meaning |
|---|---|
| `TYPESAFE_API_KEY` | The key, read from the environment |
| `DSH_TYPESAFE_ENV_FILE` | Path to an env file; only `TYPESAFE_API_KEY` is read from it |
| `DSH_BIN` | The DSH CLI to invoke (default `dsh`) |
| `DSH_BRIDGE_STATE_DIR` | Pins the state directory (default `$TMPDIR/dsh-bridge`) |

Without either key variable the bridge still works: every round runs serially
and says so. No key is ever logged, echoed, or copied.

### Reading a workflow status

`dsh_get` on a workflow returns a **bounded** view by default, because the caller
is an agent with a context budget rather than a log viewer. Children, checks and
changed files per child, scheduling decisions, and per-field string length are
all capped, and every trim is reported as an explicit count
(`children_omitted`, `scheduling_omitted`, ...). `artifact_dir` always names the
directory that still holds the complete evidence, and `counts` is never trimmed.

Failures come first — failed, then blocked, then running — so trimming can never
bury the work that needs attention, and a child's failing check is kept even when
it falls outside the per-child window. If the bounded payload is still over the
size cap, the least interesting trailing children and the oldest decisions are
dropped until it fits, and the omission counts grow to match.

Pass `include_logs=true` (the unbounded view) when you really want everything:
full summaries and reasons, every check command, every changed file, every
decision and the plan.

### Cancelling, and what a cancel does to an in-flight judgment

`dsh_cancel` sets the cancel flag, aborts any TypeSafe judgment in flight, and
requests SIGTERM for each worker this parent started that is still live in this
process. The reply separates `children_cancel_requested` from
`children_not_confirmed`; a request is not proof the process exited, and anything
a worker started itself is not signalled.

A judgment that answers *after* the workflow was cancelled or its deadline
expired is never reported as an applied decision. It is recorded with
`discarded: true` and a `discarded_reason`, so the history shows a judgment that
was deliberately not dispatched instead of a batch that ran. Nothing is ever
launched in that window: the loop re-checks cancellation and the deadline after
the judgment returns and before any worker is started.

### State and restarts

Worker jobs and parent workflows are written under `JOB_ROOT/workflows/`, kept
separate so a `dsh_list` never confuses one for the other.

A workflow snapshot outlives its process. After a restart it is reported as
**not live**: it cannot be waited on, cancelled, or resumed, and its phase is
historical. There is no process scanning and no queue — a workflow whose
controller is gone stays gone.

-----

## End-to-end verification

The Codex -> MCP -> `dsh_start` -> DSH worker -> `dsh_wait` path has been run
against a real Codex client and DSH installation:

| Step | Result |
|---|---|
| Codex discovers the server | 6 tools visible (7 after adding `dsh_delegate`) |
| `dsh_list` (read-only) | returns job list |
| `dsh_start` + `dsh_wait` (destructive) | blocked until the config key above is added |
| Delegated task, full path | Codex -> MCP -> `dsh_start` -> DSH worker -> `dsh_wait` -> answer |
| Side effect on disk | the delegated worker created the requested file with the exact requested bytes |

The `dsh_delegate` workflow path was verified offline against a fake DSH binary
(see [Tests](#tests)), and also observed end to end against a real DSH install.

## Observed root acceptance

Two real acceptance passes against a live DSH and TypeSafe install, recorded
here as observed results:

| Check | Observed |
|---|---|
| Real-DSH workflow | TypeSafe picked `count: 2` from the offered `[1, 2]` |
| Real overlap | tasks A and B genuinely overlapped; C started only after both finished |
| Verified arithmetic | outputs summed to `15`, `21`, and a total of `36`, each independently verified |
| Fresh Codex, natural-language read-only request | automatically used `dsh_delegate` then `dsh_wait` with no tool names in the prompt, and returned `15 + 21 = 36` |

## Verified behaviour

Measured against a DSH headless profile:

| Property | Observed |
|---|---|
| stdout | Final assistant message only |
| stderr | **Empty on success** — no reasoning stream on the wire |
| Delivery | One write at the end; **no incremental streaming** |
| Exit code | `0` on success |
| cwd | Inherited from the spawning process |
| Tool set | Full coding set (bash, fs, fs-search, skill, web, subagent, workflow) |

The absence of streaming is why `dsh_tail` shows nothing for a running job and
why `dsh_wait` polls status rather than parsing progress.

-----

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `DSH_BIN` | `dsh` | The CLI to invoke |
| `TYPESAFE_API_KEY` / `DSH_TYPESAFE_ENV_FILE` | none | TypeSafe credential; see [TypeSafe](#typesafe) |
| `DSH_BRIDGE_STATE_DIR` | `$TMPDIR/dsh-bridge` | Where job and workflow state is written |

Per-call options for `dsh_start`: `cwd`, `timeout_ms` (default 30 min), `profile`
(default `headless`). For `dsh_delegate`: `cwd` (required), `mode` (required),
`allowed_paths`, `timeout_ms` (default 60 min, capped at 6 h), `profile`.

-----

## Known limitations

**Path validation is not an OS sandbox.** The bridge rejects escaping paths in
the *plan*, and rejects plans a model should never have produced. But a DSH
worker runs with the DSH profile's own permissions: once it is running, the
bridge cannot stop it from touching a path its prompt never mentioned. Plan
validation constrains what is *declared and scheduled*; it does not confine what
a worker *can* do. For real isolation, point `profile` at a restricted DSH
profile.

**Concurrency is limited by declared paths, not by reality.** Two tasks are
allowed to run together when their *declared* paths do not conflict. A worker
that writes outside its declaration defeats that check. Accurate path
declarations are what make parallel execution safe.

**Every delegation creates a persistent DSH session.** Measured: 4 calls
produced 4 session directories under `~/.dsh/sessions/`. A workflow starts one
worker per task, so it creates several. High-frequency delegation accumulates
session files and can eventually hit DSH's upstream `maxHistoryBytes` limit,
which makes a session unusable. Prune periodically.

**Timeouts are enforced by the bridge, not by DSH.** DSH headless has no
built-in deadline, so a wedged worker would otherwise occupy a slot forever.

**Cancelling a workflow signals only its own direct workers.** The bridge
requests SIGTERM for each worker job it started that is still live in this
process, and reports exactly which requests were made and which were not
confirmed. A request is not proof the process exited, and anything a worker
started itself is not signalled.

**Credential-shaped environment variables are scrubbed** before spawning.
DSH reads its provider keys from `$DSH_HOME/.credentials.yaml`, so this does not
affect the child's model access.

**Sandbox and approval policy are DSH's, not Codex's.** Codex cannot control
them per delegation. If a delegated task must be restricted, point `profile` at
a purpose-built DSH profile instead of reusing `headless`.

**`mode: read-only` does not narrow a profile's MCP tools.** The mode confines
DSH's file sandbox; an MCP server wired into the profile is a separate network
capability. A read-only workflow on a profile carrying a write-capable GitHub
server can still merge a pull request. Keep the default profile read-only (the
GitHub MCP server honours an `X-MCP-Readonly: true` header) and put write access
in a separate profile that a caller selects per task. A workflow's planner
always boots the default profile, whatever `profile` the caller passes, so a
write-capable profile reaches only the task workers.

## Optional: session-boundary hook

A Codex `UserPromptSubmit` hook that suggests `/new` when a long session receives
a request for unrelated work. Every request re-sends the whole conversation, so a
session that keeps taking on new work pays for all of the old work on every turn.
Size-based auto-compaction cuts wherever the size crosses its limit, often
mid-task; a task boundary is the cleanest place to start fresh, and finding one
takes a judgment about meaning, which TypeSafe makes.

It only suggests — it cannot start a session — and it stays quiet unless the
session is already expensive (over 100,000 tokens of context), it has at least two
earlier prompts to compare against, the judgment is `new_task` with confidence of
at least 0.8, and it has not suggested in the last eight prompts. It fails open:
an error, timeout, missing key, or malformed input produces no output and exit
code 0, so a prompt is never delayed or blocked by the hook itself.

When it does judge, it sends TypeSafe the new prompt and the session's last four
prompts, each truncated to 400 characters. Nothing else leaves the machine.

Codex loads hooks from plugins. Install it as a local plugin whose
`hooks/hooks.json` points at this repository:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/env DSH_TYPESAFE_ENV_FILE=/absolute/path/to/.env /absolute/path/to/node /absolute/path/to/dsh-bridge-mcp/hooks/session-boundary.mjs",
            "timeout": 8
          }
        ]
      }
    ]
  }
}
```

Alongside it, `.codex-plugin/plugin.json` names the plugin and sets
`"hooks": "./hooks/hooks.json"`, and `.claude-plugin/marketplace.json` lists it
with `"source": "./"`. Then:

```sh
codex plugin marketplace add /absolute/path/to/your-local-plugin
codex plugin add session-boundary@<marketplace-name>
```

Codex will not run a new hook until you trust it: start `codex`, run `/hooks`,
review the command, and trust it there. Trust is recorded against the hook
definition, so editing `hooks.json` asks for review again.

Per-session state (recent prompts and the cooldown) lives under
`~/.codex/session-boundary/`, or `SESSION_BOUNDARY_STATE_DIR`; files for sessions
untouched for 14 days are removed.

-----

## Tests

```sh
npm test
```

Offline and self-contained: no network, no TypeSafe key, no real DSH session.
A fake `dsh` binary stands in for the worker, and the concurrency chooser is
injected, so scheduling decisions are deterministic.

| File | Covers |
|---|---|
| `tests/plan.mjs` | plan schema, ids, cycles, path traversal/symlink escapes, dangling/internal symlinks, allowed_paths scope, acceptance normalisation, overlap rules, pre-dispatch re-validation, evidence grading |
| `tests/workflow.mjs` | real task overlap, dependency order, conflict serialisation, invalid-plan and out-of-scope rejection, API fallback, failure blocking, cancel during judgment, deadline, final evidence |
| `tests/choices.mjs` | credential loading, no-key fallback, dynamic candidate labels, unusable answers, error redaction (`SECRET_SENTINEL`), abort during judgment |
| `tests/stdio.mjs` | settlement waits for stdio to end; complete final answer is captured |
| `tests/snapshot.mjs` | restarted snapshots are non-live and uncontrollable; malformed snapshots do not crash reads |
| `tests/cancel.mjs` | cancellation really stops the process and never over-reports |
| `tests/optimizations.mjs` | inline return, background fallback, first-finisher waiting, timeout tiers, measured defaults, prune rules, answer bound |
| `tests/wait-any.mjs` | end-to-end over stdio: a settled job returns exactly what `dsh_get` returns, failures carry their reason, the shared answer budget, first-finisher semantics, notes that steer away from polling, unknown ids |
| `tests/payload.mjs` | end-to-end over stdio: failure diagnostics by default and kept from the end of stderr, reasoning never in a reply, `include_logs` returns the whole answer only, omitted fields, compact JSON, `dsh_tail` cap, bounded `dsh_list` |
| `tests/planning-prefix.mjs` | the code-synthesised plan: no planner is started where a plan can be built, the write scope is the caller's grant, a bare-dot scope still plans and says why, `decompose:true` reaches the planner, the objective reaches the worker verbatim |
| `tests/schema-budget.mjs` | the tool schemas stay inside their re-sent-per-request budget, and every tool still carries a real description |
| `tests/settlement.mjs` | waiting ends with the work: a live job is armed, every settlement path (done, failed, cancelled) releases, an untracked subject keeps its own cadence instead of spinning, a wait loop over a set keeps waiting after one member finishes, a late waiter is told at once, and a successful workflow releases its waiters |
| `tests/persist-coalescing.mjs` | a streaming worker's snapshot writes stay bounded rather than one per chunk, and a settled, cancelled, or single-chunk job is still written in full |
| `tests/job-index.mjs` | the snapshot index: only requested fields are cached, a changed snapshot is re-read rather than served stale, explicit invalidation wins at identical size, corrupt and deleted files are skipped, and the real listing plus the dry and applied prunes agree with disk |
| `tests/session-boundary.mjs` | hook gates (history, context size, confidence, cooldown), fail-open paths, bounded data sent out, transcript tail reading, process exit behaviour without a key |

-----

## Layout

```
bin/dsh-bridge-mcp.mjs   entry point
src/server.mjs           MCP tool definitions
src/workflow.mjs         parent workflow controller
src/plan.mjs             plan validation, scheduling and overlap policy
src/choices.mjs          TypeSafe judgment and credential handling
src/evidence.mjs         worker evidence contract and grading
src/jobs.mjs             job lifecycle, spawning, persistence
src/jobindex.mjs         cached async reader for the snapshot directories
src/settle.mjs           settlement promises, so waits end with the work
src/config.mjs           constants and environment policy
hooks/session-boundary.mjs  optional Codex hook: suggest /new at task boundaries
docs/implementation.md   how the workflow is wired, end to end
docs/design.md           why the bridge exists and the shape it settled on
```
