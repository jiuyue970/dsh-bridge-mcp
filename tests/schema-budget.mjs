#!/usr/bin/env node
// The tool schemas are re-sent with every single request.
//   node tests/schema-budget.mjs
//
// Nine descriptions are cheap to write and expensive to carry: they are sent
// with every request, forever, and the cost scales with conversation length
// rather than with how often each tool is actually used. That makes them the one
// part of this codebase where "just a sentence more" has a price, and the price
// is invisible in review because nothing fails when it is paid.
//
// So it fails here. The budget is deliberately a ratchet: descriptions are
// allowed to grow, but only past a line someone has to look at.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Total characters of description plus input schema across every tool.
 *
 * 8138 chars measures ~2035 tokens. The previous version was 10279 (~2570),
 * cut from ~2442 before decompose existed. Of the current total, roughly 3000
 * chars are JSON structure — types, enums, required, additionalProperties, and
 * the $schema URL the SDK adds — which is what the tools need in order to be
 * validated at all. What is being budgeted here is the prose on top of that.
 */
const BUDGET_CHARS = 8_600;

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "..", "src", "server.mjs");

const client = new Client({ name: "schema-budget", version: "0" });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: { ...process.env },
}));

try {
  const { tools } = await client.listTools();
  let total = 0;
  let prose = 0;
  for (const tool of tools) {
    const toolDesc = (tool.description || "").length;
    const props = Object.values(tool.inputSchema?.properties ?? {});
    const propDesc = props.reduce((n, p) => n + (p.description ? p.description.length : 0), 0);
    const all = JSON.stringify(tool.inputSchema).length;
    total += toolDesc + all;
    prose += toolDesc + propDesc;
    console.log(
      "  " + tool.name.padEnd(15),
      String(toolDesc).padStart(5) + " desc",
      String(propDesc).padStart(5) + " props",
      String(all - propDesc).padStart(5) + " struct",
    );
  }
  console.log(
    "  " + "TOTAL".padEnd(15),
    String(total).padStart(5) + " chars  ~" + Math.round(total / 4) + " tokens re-sent per request",
  );
  assert.ok(
    total <= BUDGET_CHARS,
    `tool schemas grew to ${total} chars (~${Math.round(total / 4)} tokens), over the ${BUDGET_CHARS} budget. ` +
      "Cut rationale and measurements, not defaults, caps, or the facts that change what a caller does.",
  );

  // Every tool still needs a description: it is how a model knows the tool
  // exists, and an empty one silently removes it from consideration.
  for (const tool of tools) {
    assert.ok((tool.description || "").length > 40, tool.name + " needs a real description");
  }
  console.log("ok - the tool schema budget holds, and every tool is still described");
  console.log("all schema-budget checks passed");
} finally {
  await client.close();
}
