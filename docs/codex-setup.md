# Codex-side setup

The bridge needs one Codex config change to work. Without it, delegation fails.

-----

## The problem

`dsh_start` and `dsh_cancel` declare `destructiveHint: true` (they spawn a
process that can modify files). Codex gates any such MCP tool call behind an
approval request.

If `approval_policy` is `never`, that request is denied automatically and the
tool call fails with:

```
MCP tool call requires approval, but approval policy is never
```

Read-only tools (`dsh_get`, `dsh_list`, `dsh_tail`, `dsh_wait`) are unaffected,
which makes the failure look partial: listing jobs works while starting one
does not.

Note that `sandbox_mode` does not matter here. The gate is approval, not
sandboxing, so `workspace-write` and `danger-full-access` both fail the same
way.

-----

## The fix

Add `default_tools_approval_mode = "approve"` to the server block in
`~/.codex/config.toml`:

```toml
[mcp_servers.dsh-bridge]
command = "node"
args = ["/absolute/path/to/dsh-bridge-mcp/bin/dsh-bridge-mcp.mjs"]
default_tools_approval_mode = "approve"
```

Per-tool control is also available if auto-approving the whole server is too
broad:

```toml
[mcp_servers.dsh-bridge.tools.dsh_start]
approval_mode = "approve"
```

-----

## What not to do

`--dangerously-bypass-approvals-and-sandbox` does make delegation work, but it
disables approval and sandboxing for **every** command in the session. The
config change above scopes the relaxation to this one MCP server.

-----

## Verifying

```sh
cd /path/to/scratch-project
codex exec --sandbox workspace-write --skip-git-repo-check \
  "Use dsh_start with cwd='$PWD' to create proof.txt containing: HELLO, then dsh_wait."
```

A working run reports a `job_id`, `status: done`, and the worker's answer. If it
instead returns the approval error, the config key is missing or misspelled.

-----

## A benign warning

Every Codex run that loads this server ends with:

```
WARN codex_mcp::rmcp_client: failed to initialize MCP client during shutdown:
MCP startup failed: handshaking with MCP server failed: connection closed:
initialize response
```

This appears during **shutdown**, not startup. The server handshakes correctly
in about 3 seconds (measured directly), tools enumerate, and calls succeed. The
warning is a teardown race in Codex and does not affect operation.
