import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TASK = 'Reply with exactly this JSON and nothing else, using no tools: {"outcome":"success","summary":"ok","changed_files":[],"checks":[],"artifacts":[],"issues":[]}';
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [ROOT + "/bin/dsh-bridge-mcp.mjs"], cwd: ROOT, env: { ...process.env } }));
const call = async (name, args) => { const s = Date.now(); const r = await client.callTool({ name, arguments: args }); return { ms: Date.now() - s, p: JSON.parse(r.content[0].text) }; };
const runs = [];
for (let i = 0; i < 4; i++) {
  const t0 = Date.now();
  const a = await call("dsh_start", { task: TASK, cwd: "/tmp", wait_for_ms: 0 });
  const b = await call("dsh_wait", { job_id: a.p.job_id, max_wait_ms: 300000 });
  const total = Date.now() - t0;
  runs.push(total);
  console.log("run " + (i + 1) + " | start " + String(a.ms).padStart(4) + "ms | wait " + String(b.ms).padStart(6) + "ms | total " + String(total).padStart(6) + "ms | waited_ms(reported) " + b.p.waited_ms + " | status " + b.p.status);
}
const sorted = [...runs].sort((x, y) => x - y);
console.log("VIA BRIDGE -> runs: " + runs.join(", ") + " ms | median: " + sorted[Math.floor(sorted.length / 2)] + " ms");
await client.close();
