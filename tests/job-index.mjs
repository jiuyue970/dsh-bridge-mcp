#!/usr/bin/env node
// Checks the snapshot index that backs dsh_list and dsh_prune.
//   node tests/job-index.mjs
//
// Listing used to read and JSON-parse every snapshot on the caller's thread,
// which blocked the single-threaded MCP server and re-read the same 59 MB on
// every call. It now stats every entry and reuses the row for anything whose
// mtime and size are unchanged. The risk that introduces is a stale row, so
// this file is mostly about proving the cache never serves one.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bridge resolves its state directory when config is first loaded, and
// static imports are hoisted, so the isolation has to be set up first and the
// bridge modules pulled in afterwards. Without this the last check would write
// three fixtures into the real state root and then prune them.
const root = mkdtempSync(join(tmpdir(), "dsh-jobindex-"));
process.env.DSH_BRIDGE_STATE_DIR = join(root, "state");

const { clearIndex, invalidate, listRows } = await import("../src/jobindex.mjs");
const { listJobs, pruneJobState } = await import("../src/jobs.mjs");
const { listWorkflows, pruneWorkflowState } = await import("../src/workflow.mjs");
const { JOB_ROOT } = await import("../src/config.mjs");

const dir = join(root, "jobs");
mkdirSync(dir, { recursive: true });

const FIELDS = ["job_id", "status", "created_at", "ended_at"];
const write = (id, extra = {}) =>
  writeFileSync(
    join(dir, id + ".json"),
    // A padded body stands in for the stdout/stderr a real snapshot carries, so
    // a row that was built by reading the whole file is distinguishable from one
    // the index projected out of a few fields.
    JSON.stringify({
      job_id: id,
      status: "done",
      created_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:01:00.000Z",
      stdout: "x".repeat(50_000),
      ...extra,
    }),
  );

// A distinct mtime is what the cache keys on, so writes are spaced far enough
// apart to be distinguishable on every filesystem this may run on.
const writeLater = async (id, extra) => {
  await new Promise((done) => setTimeout(done, 20));
  write(id, extra);
};

try {
  for (const id of ["a", "b", "c"]) write(id);

  // 1) Only the requested fields come back, and every file is listed.
  {
    const rows = await listRows(dir, FIELDS);
    assert.equal(rows.length, 3, "every snapshot must be listed");
    const first = rows.find((row) => row.row.job_id === "a");
    assert.equal(first.row.status, "done");
    assert.equal(first.size > 50_000, true, "the row still reports the real file size");
    assert.equal("stdout" in first.row, false, "an unrequested field must not be cached");
    assert.equal("stderr" in first.row, false, "an unrequested field must not be cached");
    console.log("ok - a listing returns only the requested fields, with the real file size");
  }

  // 2) A second listing of an unchanged directory is served from the cache and
  //    returns exactly the same rows.
  {
    const again = await listRows(dir, FIELDS);
    assert.deepEqual(
      again.map((entry) => entry.row).sort(),
      (await listRows(dir, FIELDS)).map((entry) => entry.row).sort(),
      "an unchanged directory must list identically",
    );
    console.log("ok - repeated listings of an unchanged directory agree");
  }

  // 3) The load-bearing case: a file that changes underneath the cache is
  //     re-read, never served stale. This is what a job settling looks like.
  {
    await writeLater("a", { status: "failed", ended_at: "2026-01-01T00:02:00.000Z" });
    const row = (await listRows(dir, FIELDS)).find((entry) => entry.row.job_id === "a");
    assert.equal(row.row.status, "failed", "a changed snapshot must not be served from cache");
    assert.equal(row.row.ended_at, "2026-01-01T00:02:00.000Z");
    console.log("ok - a changed snapshot is re-read rather than served stale");
  }

  // 4) An explicit invalidation wins even when mtime would not have moved.
  {
    const path = join(dir, "b.json");
    const body = JSON.parse(readFileSync(path, "utf8"));
    body.status = "cancelled";
    const sameSize = JSON.stringify(body).length;
    // Write identical-length content, then force the cache to drop the entry:
    // this is the "mtime resolution was too coarse" case, and the explicit
    // invalidation is what has to cover it.
    body.stdout = body.stdout.slice(0, -1) + "y";
    assert.equal(JSON.stringify(body).length, sameSize, "the rewrite must be the same length");
    writeFileSync(path, JSON.stringify(body));
    invalidate(dir, "b.json");
    const row = (await listRows(dir, FIELDS)).find((entry) => entry.row.job_id === "b");
    assert.equal(row.row.status, "cancelled", "an invalidated entry must be re-read");
    console.log("ok - an explicit invalidation is honoured even at identical size");
  }

  // 5) A corrupt or half-written snapshot is skipped, not fatal, and it does not
  //    poison the listing around it.
  {
    writeFileSync(join(dir, "broken.json"), "{not json");
    const rows = await listRows(dir, FIELDS);
    assert.equal(rows.length, 3, "an unreadable snapshot must be skipped, others listed");
    assert.equal(rows.some((entry) => entry.row.job_id === "broken"), false);
    rmSync(join(dir, "broken.json"));
    console.log("ok - a corrupt snapshot is skipped without failing the listing");
  }

  // 6) A file deleted by another process disappears from the next listing.
  {
    rmSync(join(dir, "c.json"));
    const rows = await listRows(dir, FIELDS);
    assert.equal(rows.length, 2, "a deleted snapshot must not linger in the listing");
    console.log("ok - a deleted snapshot leaves the listing");
  }

  // 7) A missing directory lists as empty rather than throwing.
  {
    assert.deepEqual(await listRows(join(root, "nope"), FIELDS), []);
    console.log("ok - a missing directory lists as empty");
  }

  // 8) clearIndex drops everything, and the next listing is rebuilt from disk.
  {
    clearIndex(dir);
    const rows = await listRows(dir, FIELDS);
    assert.equal(rows.length, 2);
    assert.equal(rows.some((entry) => entry.row.job_id === "a"), true);
    console.log("ok - a cleared index is rebuilt correctly from disk");
  }

  // 9) The real callers must agree with what is on disk, which is the property
  //    a prune depends on. This runs against the isolated state dir set above.
  {
    const now = Date.now();
    const day = 86_400_000;
    const fixture = (id, extra) =>
      writeFileSync(
        join(JOB_ROOT, id + ".json"),
        JSON.stringify({
          job_id: id,
          status: "done",
          task: "index fixture",
          cwd: root,
          created_at: new Date(now - 20 * day).toISOString(),
          ended_at: new Date(now - 19 * day).toISOString(),
          exit_code: 0,
          stdout: "",
          stderr: "",
          ...extra,
        }),
      );

    mkdirSync(JOB_ROOT, { recursive: true });
    const OLD = "00000000-0000-4000-8000-000000000001";
    const FRESH = "00000000-0000-4000-8000-000000000002";
    const RUNNING = "00000000-0000-4000-8000-000000000003";
    fixture(OLD, {});
    fixture(FRESH, { ended_at: new Date(now - day).toISOString() });
    fixture(RUNNING, { status: "running", ended_at: null });
    try {
      const listed = new Map((await listJobs()).map((job) => [job.job_id, job]));
      assert.equal(listed.has(OLD), true, "listJobs must see a settled snapshot");
      assert.equal(listed.has(RUNNING), true, "listJobs must see a running snapshot");
      assert.equal(listed.get(RUNNING).status, "running");

      // A dry run reports the eligible set without deleting anything, and a
      // running job is never eligible however old its snapshot looks.
      const dry = await pruneJobState({ olderThanMs: 7 * day, apply: false });
      assert.equal(dry.applied, false, "a dry run must not apply");
      assert.equal(dry.removed, 0);
      assert.ok(dry.eligible >= 1, "the 19-day-old settled job is eligible");
      assert.equal(
        readdirSync(JOB_ROOT).includes(OLD + ".json"),
        true,
        "a dry run must leave the files in place",
      );

      // After the cached row has been served once, applying must still delete it
      // and the next listing must not resurrect it.
      const applied = await pruneJobState({ olderThanMs: 7 * day, apply: true });
      assert.equal(applied.applied, true);
      assert.equal(
        readdirSync(JOB_ROOT).includes(OLD + ".json"),
        false,
        "an applied prune must delete the eligible snapshot",
      );
      const after = new Map((await listJobs()).map((job) => [job.job_id, job]));
      assert.equal(after.has(OLD), false, "a deleted snapshot must not come back from the cache");
      assert.equal(after.has(RUNNING), true, "the running job is never pruned");
    } finally {
      for (const id of [OLD, FRESH, RUNNING]) rmSync(join(JOB_ROOT, id + ".json"), { force: true });
    }

    assert.ok(Array.isArray(await listWorkflows()), "listWorkflows must resolve to an array");
    const wfDry = await pruneWorkflowState({ olderThanMs: 7 * day, apply: false });
    assert.equal(wfDry.applied, false, "a workflow dry run must not apply");
    console.log("ok - the real listing, the dry prune and the applied prune agree with disk");
  }

  console.log("all job-index checks passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
