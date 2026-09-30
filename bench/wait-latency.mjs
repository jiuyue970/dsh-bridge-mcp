#!/usr/bin/env node
// How late does a wait return after the work it was waiting on actually ended?
//   node bench/wait-latency.mjs [trials]
//
// Every wait used to be a poll on a 250 ms cadence, so a wait returned on the
// first tick after settlement: uniformly 0-250 ms late, ~125 ms on average, once
// per hop. Settlement is an event, so the overshoot should now be the cost of
// one event-loop turn rather than of a timer.
//
// The measured value is (time waitJob returned) - (the job's own ended_at),
// which needs no reference clock and no guess about what the worker was doing.
import { readJob, startJob, waitJob } from "../src/jobs.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const trials = Number(process.argv[2] ?? 12);
const workMs = Number(process.env.FAKE_DSH_MS ?? 500);
const here = dirname(fileURLToPath(import.meta.url));
const spawner = join(here, "fake-dsh");

const overshoot = [];
const wall = [];
for (let i = 0; i < trials; i += 1) {
  const startedAt = Date.now();
  const job = startJob({ task: "bench the wait", cwd: here, dshBin: spawner, timeoutMs: 60_000 });
  await waitJob(job.job_id, 60_000);
  const returnedAt = Date.now();
  const endedAt = Date.parse(readJob(job.job_id).ended_at);
  overshoot.push(returnedAt - endedAt);
  wall.push(returnedAt - startedAt);
  // Let the loop breathe so one trial does not measure the next.
  await new Promise((r) => setTimeout(r, 60));
}

const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: sorted[Math.floor(sorted.length / 2)],
    max: sorted[sorted.length - 1],
  };
};
const over = stats(overshoot);
const wallStats = stats(wall);

console.log("trials           :", trials, "at", workMs + " ms of work each");
console.log("wait overshoot   : mean " + over.mean.toFixed(1) + " ms | median " + over.median + " ms | max " + over.max + " ms");
console.log("  (poll ceiling   mean 125.0 ms | median ~125 ms | max 250 ms)");
console.log("end-to-end wall  : mean " + wallStats.mean.toFixed(1) + " ms | median " + wallStats.median + " ms");
console.log("samples (ms)     : " + overshoot.join(", "));
