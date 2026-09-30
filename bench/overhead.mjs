#!/usr/bin/env node
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Fixed-overhead probe. Runs one dsh_delegate workflow and one dsh_start job at
// two worker latencies; the slope is the number of workers the bridge spawns,
// and the intercept is the bridge's own fixed cost.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE = ROOT + "/bench/fake-dsh.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withBridge(fakeMs, fn) {
  const client = new Client({ name: "bench", version: "0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [ROOT + "/bin/dsh-bridge-mcp.mjs"], cwd: ROOT,
    env: { ...process.env, NODE: process.execPath, DSH_BIN: ROOT + "/bench/fake-dsh", FAKE_DSH_MS: String(fakeMs), DSH_BRIDGE_STATE_DIR: "/tmp/bench-state-" + fakeMs },
  }));
  try { return await fn(client); } finally { await client.close(); }
}
const call = async (c, n, a) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text);

async function timeStart(c) {
  const t = Date.now();
  const a = await call(c, "dsh_start", { task: "do the one thing", cwd: "/tmp", wait_for_ms: 0 });
  await call(c, "dsh_wait", { job_id: a.job_id, max_wait_ms: 60000 });
  return Date.now() - t;
}
async function timeDelegate(c) {
  const t = Date.now();
  const d = await call(c, "dsh_delegate", { task: "do the one thing", cwd: "/tmp", mode: "read-only", tier: "investigate" });
  let phase = d.phase, planMs = null;
  for (let i = 0; i < 20000; i++) {
    const s = await call(c, "dsh_get", { job_id: d.job_id });
    if (s.phase !== phase) { if (phase === "planning") planMs = Date.now() - t; phase = s.phase; }
    if (s.status === "awaiting_review" || s.status === "failed" || s.status === "timed-out") break;
    await sleep(5);
  }
  const total = Date.now() - t;
  return { total, planMs };
}
const rows = [];
for (const ms of [100, 600]) {
  const start = await withBridge(ms, timeStart);
  const del = await withBridge(ms, (c) => timeDelegate(c));
  rows.push({ ms, start, del: del.total, plan: del.planMs });
  console.log("FAKE_DSH_MS=" + String(ms).padStart(4) +
    " | dsh_start=" + String(start).padStart(5) + "ms" +
    " | dsh_delegate=" + String(del.total).padStart(5) + "ms" +
    "  of which planning=" + String(del.planMs).padStart(5) + "ms" +
    " (" + ((del.planMs / del.total) * 100).toFixed(0) + "% of the workflow)");
}
const slope = (rows[1].del - rows[0].del) / (rows[1].ms - rows[0].ms);
const intercept = rows[0].del - slope * rows[0].ms;
console.log("\ndsh_delegate: workers spawned per workflow = " + slope.toFixed(2) + "  (slope)");
console.log("dsh_delegate: bridge fixed overhead = " + intercept.toFixed(0) + " ms  (intercept, worker time removed)");
console.log("planning adds " + ((intercept)).toFixed(0) + " ms of pure serial prefix before any work starts");
await sleep(50);
