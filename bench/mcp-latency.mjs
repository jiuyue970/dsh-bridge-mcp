#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Latency harness: boots the real bridge over stdio as an MCP client and times
// every tool call. Usage: node bench/mcp-latency.mjs [--full]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ROOT + "/bin/dsh-bridge-mcp.mjs"],
  cwd: ROOT,
  env: { ...process.env },
});
const t0 = process.hrtime.bigint();
const client = new Client({ name: "bench", version: "0" });
await client.connect(transport);
const boot = Number(process.hrtime.bigint() - t0) / 1e6;
console.log("server boot + initialize handshake:".padEnd(44), boot.toFixed(0) + " ms");

const call = async (name, args) => {
  const s = process.hrtime.bigint();
  const r = await client.callTool({ name, arguments: args });
  const ms = Number(process.hrtime.bigint() - s) / 1e6;
  const text = r.content?.[0]?.text ?? "";
  return { ms, text, bytes: text.length, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const show = (label, r, extra = "") =>
  console.log(label.padEnd(44), (r.ms.toFixed(0) + " ms").padStart(8), ("resp " + r.bytes + "B").padStart(11), extra);

// --- read-only calls -------------------------------------------------------
// The first listing in a process pays the read of every snapshot; later ones
// cost one stat per file, so both numbers matter.
show("dsh_list(limit 20)  [cold, first call]", await call("dsh_list", { limit: 20 }));
show("dsh_list(limit 20)  [warm, index hit]", await call("dsh_list", { limit: 20 }));
show("dsh_list(limit 20)  [warm again]", await call("dsh_list", { limit: 20 }));
show("dsh_get(unknown id)", await call("dsh_get", { job_id: "00000000-0000-0000-0000-000000000000" }));

// Event-loop blocking probe: fire a cheap call behind a COLD listing and time
// it. The cheap call is the one that shows whether the listing blocked the
// server, so it is timed on its own, not as part of the pair.
for (const [label, args] of [
  ["cold", { limit: 5 }],
  ["warm", { limit: 5 }],
]) {
  // Only the first pass in this process can still be cold.
  const s = process.hrtime.bigint();
  const slow = client.callTool({ name: "dsh_list", arguments: args });
  await new Promise((r) => setTimeout(r, 1));
  const cheapStart = process.hrtime.bigint();
  await client.callTool({ name: "dsh_get", arguments: { job_id: "00000000-0000-0000-0000-000000000000" } });
  const cheapMs = Number(process.hrtime.bigint() - cheapStart) / 1e6;
  await slow;
  console.log(
    ("  -> cheap dsh_get queued behind dsh_list [" + label + "]:").padEnd(44),
    cheapMs.toFixed(0) + " ms for the cheap call alone",
  );
}

// --- one real worker round trip -------------------------------------------
const TASK = "Reply with exactly this JSON and nothing else, using no tools: {\"outcome\":\"success\",\"summary\":\"ok\",\"changed_files\":[],\"checks\":[],\"artifacts\":[],\"issues\":[]}";
const s0 = Date.now();
const started = await call("dsh_start", { task: TASK, cwd: "/tmp", wait_for_ms: 0 });
show("dsh_start(wait_for_ms:0) -> job_id", started, "spawn only");
const waited = await call("dsh_wait", { job_id: started.parsed.job_id, max_wait_ms: 300000 });
show("dsh_wait(settle)", waited, "status=" + waited.parsed?.status);
console.log("END-TO-END WORKER ROUND TRIP:".padEnd(44), ((Date.now() - s0) / 1000).toFixed(1) + " s",
  "| answer_chars=" + waited.parsed?.answer_chars);
await client.close();
