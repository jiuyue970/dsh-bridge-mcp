import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const c = new Client({ name: "bench", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [ROOT + "/bin/dsh-bridge-mcp.mjs"], cwd: ROOT, env: { ...process.env } }));
const { tools } = await c.listTools();
let total = 0;
console.log("tool".padEnd(16), "desc chars".padStart(12), "schema chars".padStart(13), "  approx tokens");
for (const t of tools) {
  const d = (t.description || "").length;
  const s = JSON.stringify(t.inputSchema).length;
  total += d + s;
  console.log(t.name.padEnd(16), String(d).padStart(12), String(s).padStart(13), "  " + Math.round((d + s) / 4));
}
console.log("-".repeat(70));
console.log("TOTAL tool schema inlined into EVERY request: " + total + " chars  ~= " + Math.round(total / 4) + " tokens");
await c.close();
