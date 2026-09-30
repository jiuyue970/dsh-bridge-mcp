#!/usr/bin/env node
// The write side of the snapshot store.
//   node tests/persist-coalescing.mjs
//
// A snapshot used to be rewritten synchronously on every stdout chunk. The
// child decides how many chunks stdout arrives in, so the cost of a running
// job grew with the square of its answer and blocked the event loop while it
// grew. Writes are now bounded per interval instead.
//
// The bound is only allowed to apply to a job that is still running. Settling
// must always write through immediately, or a finished job's answer would be
// missing from disk -- which is the one thing this module exists to record.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const stateDir = mkdtempSync(join(tmpdir(), "dsh-persist-"));
process.env.DSH_BRIDGE_STATE_DIR = stateDir;
const scratch = mkdtempSync(join(tmpdir(), "dsh-persist-proj-"));

const here = dirname(fileURLToPath(import.meta.url));
const { startJob, waitJob, readJob, cancelJob } = await import(join(here, "..", "src", "jobs.mjs"));

const jobFile = (id) => join(stateDir, "jobs", id + ".json");

/** A worker that writes \`count\` chunks of \`chars\`, \`gap\` ms apart. */
function streamingWorker(chunks, chars, gap) {
  const path = join(scratch, "worker-" + chunks + "-" + chars + "-" + gap);
  writeFileSync(
    path,
    "#!/usr/bin/env node\n" +
    "let i = 0;\n" +
    "const t = setInterval(() => {\n" +
    "  process.stdout.write('x'.repeat(" + chars + "));\n" +
    "  if (++i >= " + chunks + ") { clearInterval(t); process.exit(0); }\n" +
    "}, " + gap + ");\n",
    { mode: 0o700 },
  );
  return path;
}

/** Count rewrites of one snapshot file while \`fn\` runs. */
async function countWrites(path, fn) {
  let writes = 0;
  const watcher = watch(path, () => { writes += 1; });
  try {
    await fn();
  } finally {
    watcher.close();
  }
  return writes;
}

try {
  // 1. A streaming worker's writes are bounded, not one per chunk.
  {
    const chunks = 60;
    const chars = 2000;
    const dshBin = streamingWorker(chunks, chars, 8); // ~480 ms of output
    const job = startJob({ task: "stream", cwd: scratch, dshBin, timeoutMs: 60_000 });
    // The first write creates the file; only count rewrites of it.
    await new Promise((r) => setTimeout(r, 30));
    const writes = await countWrites(jobFile(job.job_id), () => waitJob(job.job_id, 60_000));

    assert.ok(
      writes < chunks / 4,
      "a " + chunks + "-chunk stream must not cost " + chunks + " snapshot writes (cost " + writes + ")",
    );
    console.log("ok - " + chunks + " stdout chunks cost " + writes + " snapshot writes, not " + chunks);
  }

  // 2. The finished job is complete on disk, despite the coalescing.
  {
    const chunks = 40;
    const chars = 2000;
    const dshBin = streamingWorker(chunks, chars, 8);
    const job = startJob({ task: "stream", cwd: scratch, dshBin, timeoutMs: 60_000 });
    await waitJob(job.job_id, 60_000);

    const persisted = JSON.parse(readFileSync(jobFile(job.job_id), "utf8"));
    assert.equal(persisted.status, "done", "the settled status must reach disk");
    assert.ok(persisted.ended_at !== null && persisted.ended_at !== undefined, "ended_at must reach disk");
    assert.equal(
      persisted.stdout.length,
      chunks * chars,
      "the whole answer must reach disk, not just the last chunk (" +
        persisted.stdout.length + " of " + chunks * chars + " chars)",
    );
    const inMemory = readJob(job.job_id);
    assert.equal(inMemory.stdout.length, persisted.stdout.length, "disk and memory must agree");
    console.log("ok - a settled job is written in full (" + persisted.stdout.length + " chars on disk)");
  }

  // 3. Cancelling flushes too: a cancelled job is terminal, so its record must
  //    not be waiting on a timer that may never be reached.
  {
    const dshBin = streamingWorker(1000, 2000, 20);
    const job = startJob({ task: "stream", cwd: scratch, dshBin, timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 120));
    const result = cancelJob(job.job_id);
    assert.equal(result.cancelled, true, "the cancellation must be delivered");
    await waitJob(job.job_id, 60_000);

    const persisted = JSON.parse(readFileSync(jobFile(job.job_id), "utf8"));
    assert.equal(persisted.status, "cancelled", "the cancelled status must reach disk immediately");
    assert.equal(persisted.error, "cancelled by request");
    console.log("ok - cancellation reaches disk without waiting for the timer");
  }

  // 4. The bound must not apply to a job that never streams: a small answer
  //    written once is still written promptly, not deferred by the interval.
  {
    const path = join(scratch, "single-write");
    writeFileSync(
      path,
      "#!/usr/bin/env node\n" +
      "process.stdout.write('done');\n" +
      "process.exit(0);\n",
      { mode: 0o700 },
    );
    const job = startJob({ task: "quick", cwd: scratch, dshBin: path, timeoutMs: 60_000 });
    await waitJob(job.job_id, 60_000);
    const persisted = JSON.parse(readFileSync(jobFile(job.job_id), "utf8"));
    assert.equal(persisted.stdout, "done", "a single-chunk answer must still be recorded");
    console.log("ok - a single-chunk answer is still recorded");
  }

  console.log("all persist-coalescing checks passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
}
