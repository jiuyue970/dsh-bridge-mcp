#!/usr/bin/env node
// A deterministic stand-in for the dsh CLI. FAKE_DSH_MS sets the per-worker
// latency, so a run's wall time is FAKE_DSH_MS * (number of workers) + fixed
// overhead. Varying FAKE_DSH_MS isolates the fixed overhead from model time.
const task = process.argv[process.argv.length - 1] ?? "";
const ms = Number(process.env.FAKE_DSH_MS ?? 200);
await new Promise((r) => setTimeout(r, ms));
if (task.startsWith("You are a planning worker")) {
  process.stdout.write(JSON.stringify({ tasks: [{ id: "t1", task: "do the one thing", read_paths: ["package.json"], write_paths: [], depends_on: [], acceptance: "it is done" }] }));
} else {
  process.stdout.write(JSON.stringify({ outcome: "success", summary: "did the one thing", changed_files: [], checks: [{ command: "true", exit_code: 0 }], artifacts: [], issues: [] }));
}
