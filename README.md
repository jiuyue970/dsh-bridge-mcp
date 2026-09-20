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
| `dsh_get` | Compact status + final answer (worker job **or** workflow) |
| `dsh_wait` | Block until settled, bounded window |
| `dsh_wait_any` | Watch several jobs with one call; return on the first finisher |
| `dsh_tail` | Output tail for debugging |
| `dsh_cancel` | Stop a running job or a whole workflow |
| `dsh_list` | List known jobs and workflows |
| `dsh_prune` | Report, and optionally delete, finished bridge state |

### `dsh_delegate` — the managed workflow

One call owns a complete objective. It starts a read-only DSH planner, validates
the plan **in code**, asks TypeSafe how many safe tasks to start at once, runs one
DSH worker per task, and finishes in `awaiting_review`.

```
dsh_delegate(
  task="Add input validation to src/api.ts and cover it with tests",
  cwd="/repo",                       # required, absolute
  mode="workspace-write",            # or "read-only"
  allowed_paths=["src", "tests"],    # optional, relative to cwd; default project root
  timeout_ms=3600000)                # total deadline for planning + all tasks
  -> { job_id: "...", kind: "workflow", status: "planning" }
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
dsh_wait(job_id="...", max_wait_ms=300000)
  -> { status: "awaiting_review", counts: {...}, children: [...] }
```

### Keeping the round trips down

Every poll is a full request from the calling agent, carrying its whole
conversation, so polling — not the delegated work — tends to dominate the
caller's token cost. Three parameters exist for that reason:

- **`wait_for_ms` on `dsh_start`** holds the call open briefly and returns the
  finished result inline. Short jobs are the common case, and this collapses the
  usual start-then-poll pair into one round trip.
- **`max_wait_ms` on `dsh_wait`** defaults to 300000. Prefer one long window over
  several short ones; the call still returns the moment the job settles.
- **`dsh_wait_any`** watches a whole parallel set with one call. Without it, N
  parallel jobs cost N polling chains to learn the same thing.

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
src/config.mjs           constants and environment policy
docs/implementation.md   how the workflow is wired, end to end
docs/design.md           why the bridge exists and the shape it settled on
```
