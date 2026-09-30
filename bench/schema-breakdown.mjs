import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const c = new Client({ name: "bench", version: "0" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [ROOT + "/bin/dsh-bridge-mcp.mjs"], cwd: ROOT, env: { ...process.env } }));
const { tools } = await c.listTools();
let tTool = 0, tProp = 0, tStruct = 0;
console.log("tool".padEnd(15), "tooldesc".padStart(9), "propdesc".padStart(9), "struct".padStart(8), "  tot");
for (const t of tools) {
  const props = Object.values(t.inputSchema?.properties ?? {});
  const propDesc = props.reduce((a, p) => a + (p.description ? p.description.length : 0), 0);
  const full = JSON.stringify(t.inputSchema).length;
  const toolDesc = (t.description || "").length;
  const struct = full - propDesc;
  tTool += toolDesc; tProp += propDesc; tStruct += struct;
  console.log(t.name.padEnd(15), String(toolDesc).padStart(9), String(propDesc).padStart(9), String(struct).padStart(8), "  " + (toolDesc + full));
}
console.log("-".repeat(58));
console.log("TOTALS     ", String(tTool).padStart(9), String(tProp).padStart(9), String(tStruct).padStart(8), "  " + (tTool + tProp + tStruct));
console.log("approx tokens:  tool " + Math.round(tTool/4) + " | props " + Math.round(tProp/4) + " | structure " + Math.round(tStruct/4));
await c.close();
