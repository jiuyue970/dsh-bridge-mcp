import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const client = new Client({ name: "bench", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [ROOT + "/bin/dsh-bridge-mcp.mjs"], cwd: ROOT, env: { ...process.env } }));
const call = async (n, a) => { const r = await client.callTool({ name: n, arguments: a }); return JSON.parse(r.content[0].text); };
const T0 = Date.now();
const el = () => ((Date.now() - T0) / 1000).toFixed(1) + "s";
const d = await call("dsh_delegate", {
  task: "Read the file ROOT/package.json and report the package name and version. Do not modify anything.",
  cwd: ROOT,
  mode: "read-only",
  tier: "investigate",
});
console.log("[" + el() + "] delegate returned job_id, status=" + d.status + " phase=" + d.phase);
let last = d.phase;
for (let i = 0; i < 400; i++) {
  const s = await call("dsh_get", { job_id: d.job_id });
  if (s.phase !== last) { console.log("[" + el() + "] PHASE -> " + s.phase + "  counts=" + JSON.stringify(s.counts)); last = s.phase; }
  if (s.phase === "awaiting_review" || s.status === "failed" || s.status === "timed-out") {
    console.log("[" + el() + "] SETTLED status=" + s.status);
    for (const c of s.children || []) console.log("   task " + c.task_id + ": " + c.status + " / " + c.outcome + " | " + (c.reason || "").slice(0, 80) + " | " + (c.summary || "").slice(0, 70));
    break;
  }
  await new Promise(r => setTimeout(r, 1000));
}
console.log("TOTAL WORKFLOW WALL TIME: " + el());
await client.close();
