#!/usr/bin/env node
/**
 * dsh-console — the local console for this repository's own DSH MCP bridge.
 *
 * A thin launcher: the HTTP surface lives in src/console/server.mjs and the
 * MCP runtime adapter in src/console/bridge.mjs. Binding is 127.0.0.1 only.
 */
import { main } from "../src/console/server.mjs";

main().catch((error) => {
  process.stderr.write(`[console] failed to start: ${error?.stack ?? error}\n`);
  process.exit(1);
});
