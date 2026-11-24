/**
 * The runtime adapter: this console drives the *real* MCP server.
 *
 * Every job read and every job started goes through a genuine MCP round trip
 * (`tools/call`) against this repository's own `bin/dsh-bridge-mcp.mjs`, using
 * the SDK's own `Client` and `StdioClientTransport`. Nothing here imports
 * `src/jobs.mjs` or any other bridge module, so the console can never report a
 * status the MCP tools would not themselves report.
 *
 * Two properties are load-bearing:
 *
 *  1. One shared state directory. `DSH_BRIDGE_STATE_DIR` is passed explicitly
 *     and is the bridge's own default (`resolve(tmpdir(), "dsh-bridge")`), so
 *     this console observes MCP clients using that configured store.
 *     A private directory here would hide those
 *     external task, which is the opposite of what this console exists for.
 *
 *  2. Nothing is invented. A tool result is decoded from the JSON text the
 *     bridge returned; a refusal is raised as a refusal. There is no fallback
 *     shape, no synthesised status, and no locally computed answer.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONSOLE_DIR = dirname(fileURLToPath(import.meta.url));

/** This repository. The console lives inside it, beside the MCP server. */
export const REPO_ROOT = resolve(CONSOLE_DIR, "..", "..");

/** The real MCP entry point this console spawns and speaks to. */
export const MCP_ENTRY = join(REPO_ROOT, "bin", "dsh-bridge-mcp.mjs");

/**
 * The shared bridge state root, computed exactly as `src/config.mjs` computes
 * it, so the child resolves the same directory even if the environment shifts.
 */
export function sharedStateRoot(env = process.env) {
  const pinned = typeof env.DSH_BRIDGE_STATE_DIR === "string" ? env.DSH_BRIDGE_STATE_DIR.trim() : "";
  return pinned === "" ? resolve(tmpdir(), "dsh-bridge") : resolve(pinned);
}

/** The bridge said no, in its own words. `notFound` is its "no such job" case. */
export class BridgeToolError extends Error {
  constructor(message, { tool, notFound = false } = {}) {
    super(message);
    this.name = "BridgeToolError";
    this.tool = tool;
    this.notFound = notFound;
  }
}

/** The MCP child could not be reached at all; nothing about a job is known. */
export class BridgeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/**
 * Decode one `tools/call` result.
 *
 * The bridge answers with a single JSON text block. An `isError` result is the
 * bridge's refusal and is raised as one; a block that is not JSON is never
 * silently coerced into a shape, because a made-up status is exactly the
 * failure mode this console must not have.
 */
function decode(result, tool) {
  const text = Array.isArray(result?.content)
    ? result.content.find((block) => block?.type === "text")?.text
    : undefined;
  if (typeof text !== "string" || text.trim() === "") {
    throw new BridgeToolError(`tool ${tool} returned no text content`, { tool });
  }
  if (result?.isError === true) {
    throw new BridgeToolError(text, { tool, notFound: /unknown job_id/.test(text) });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BridgeToolError(`tool ${tool} returned a result that is not JSON: ${error.message}`, { tool });
  }
}

/**
 * Connect to the bridge and expose the four operations this console needs.
 *
 * One connection owns the jobs it starts. A lost connection is reported and
 * never replaced automatically: a replacement has no creator handles for
 * those jobs, and an unanswered mutation must never start a duplicate run.
 */
export async function createBridge(options = {}) {
  const entry = options.entry ?? MCP_ENTRY;
  const stateRoot = options.stateRoot ?? sharedStateRoot();
  const onStderr = options.onStderr ?? ((line) => process.stderr.write(`[mcp] ${line}\n`));
  const client = new Client({ name: "dsh-console", version: "0.1.0" }, { capabilities: {} });

  let transport = null;
  let opened = false;

  function childEnv() {
    const env = getDefaultEnvironment();
    // The shared store, pinned explicitly rather than inherited.
    env.DSH_BRIDGE_STATE_DIR = stateRoot;
    // Names the bridge legitimately needs; it scrubs credential-shaped
    // variables from the workers it spawns itself.
    for (const key of ["DSH_HOME", "TMPDIR", "DSH_BIN"]) {
      if (typeof process.env[key] === "string" && process.env[key] !== "") env[key] = process.env[key];
    }
    return env;
  }

  async function open() {
    if (opened) return;
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: childEnv(),
      cwd: REPO_ROOT,
      stderr: "pipe",
    });
    // The child's stderr must be drained or a full pipe would block it.
    transport.stderr?.on("data", (chunk) => onStderr(String(chunk).trimEnd()));
    client.onerror = (error) => onStderr(`client error: ${error?.message ?? error}`);
    client.onclose = () => { opened = false; };
    await client.connect(transport);
    opened = true;
    onStderr(`connected - state root ${stateRoot}`);
  }

  async function drop() {
    opened = false;
    const dying = transport;
    transport = null;
    try {
      await client.close();
    } catch {
      /* the child is already gone; nothing left to shut down */
    }
    if (dying !== null) {
      try {
        await dying.close();
      } catch {
        /* reported through the client error handler above */
      }
    }
  }

  async function call(tool, args) {
    if (!opened) throw new BridgeUnavailableError("MCP connection is closed; restart the console to reconnect");
    try {
      return decode(await client.callTool({ name: tool, arguments: args }), tool);
    } catch (error) {
      if (error instanceof BridgeToolError) throw error;
      await drop();
      throw new BridgeUnavailableError(`MCP tool ${tool} is unreachable: ${error?.message ?? error}`);
    }
  }

  const bridge = {
    entry,
    stateRoot,

    /** True once the stdio child is up; reported, never assumed. */
    isConnected: () => opened,

    /** `dsh_start`: one delegated task, returning a job id at once. */
    async startJob({ task, cwd, timeoutMs, profile }) {
      const args = { task, ...(cwd === undefined ? {} : { cwd }) };
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) args.timeout_ms = timeoutMs;
      if (typeof profile === "string" && profile !== "") args.profile = profile;
      return call("dsh_start", args);
    },

    /** `dsh_get`: one job or parent workflow, or undefined when unknown. */
    async readJob(jobId) {
      try {
        return await call("dsh_get", { job_id: jobId });
      } catch (error) {
        if (error instanceof BridgeToolError && error.notFound) return undefined;
        throw error;
      }
    },

    /** `dsh_list`: worker jobs and parent workflows, newest first. */
    async listJobs({ limit } = {}) {
      const args = limit === undefined ? {} : { limit };
      return call("dsh_list", args);
    },

    /** `dsh_cancel`: reports what the bridge actually did, never a promise. */
    async cancelJob(jobId) {
      return call("dsh_cancel", { job_id: jobId });
    },

    /** Shut the child down. Never touches worker processes on its own. */
    close: () => drop(),
  };

  await open();
  return bridge;
}

/** Names the console shows for a task it did not start. Not a role. */
export const EXTERNAL_SOURCE = "MCP共享状态";

/** The role field for an external task: honest about being unknown. */
export const EXTERNAL_ROLE = "unknown";
