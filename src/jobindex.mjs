import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Bounded-concurrency reader for the snapshot directories.
 *
 * Listing a directory used to read and JSON-parse every snapshot in it, on the
 * caller's thread. That is the wrong shape for two reasons. It blocked the
 * single-threaded MCP server, so a cheap call queued behind dsh_list waited
 * with it, and it paid for the same bytes every time: measured on this machine,
 * stat over all 2,675 job snapshots costs 5.8 ms while reading them costs
 * 1,802 ms, and the parse is only ~170 ms of that. The cost was the I/O, not
 * the JSON, and none of it changes unless the file does.
 *
 * So each directory keeps a cache keyed by the file's mtime and size. A listing
 * stats every entry, reuses the row for anything unchanged, and reads only what
 * actually moved. The first listing after a process starts still reads
 * everything, but it does so without blocking the event loop, and every later
 * one is a stat sweep.
 *
 * Only the requested fields are kept, so the cache holds a few hundred bytes per
 * job rather than the full stdout and stderr, which is what made the state
 * directory expensive to hold in the first place.
 */

/** How many files are read at once. Enough to keep the disk busy, not enough to exhaust the fd table. */
const READ_CONCURRENCY = 64;

/** Above this the cache is dropped wholesale rather than grown without bound. */
const MAX_CACHED_FILES = 50_000;

/** dir -> Map(fileName -> cached row). */
const caches = new Map();

function cacheFor(dir) {
  let cache = caches.get(dir);
  if (cache === undefined) {
    cache = new Map();
    caches.set(dir, cache);
  }
  return cache;
}

/**
 * Drop one entry, after this process has written or deleted that file.
 *
 * The mtime check already catches the change; doing it here as well means a
 * write that lands inside the filesystem's mtime resolution cannot be served
 * from a stale row.
 */
export function invalidate(dir, name) {
  const cache = caches.get(dir);
  if (cache !== undefined) cache.delete(name);
}

/** Forget every cached row for a directory. */
export function clearIndex(dir) {
  caches.delete(dir);
}

/**
 * Read the listed rows of every JSON file in a directory.
 *
 * Returns { name, size, row } for each readable file, where row carries only the
 * requested fields. A file that disappears, or whose JSON will not parse, is
 * skipped and its cache entry dropped, so one unreadable snapshot never fails a
 * listing.
 */
export async function listRows(dir, fields, isWanted = () => true) {
  const cache = cacheFor(dir);
  if (cache.size > MAX_CACHED_FILES) cache.clear();

  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json") && isWanted(name));
  } catch {
    // An unreadable directory simply has nothing to list.
    return [];
  }

  const rows = new Array(names.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, names.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= names.length) return;
      const name = names[index];
      const path = join(dir, name);

      let info;
      try {
        info = await stat(path);
      } catch {
        // Deleted between the listing and the stat.
        cache.delete(name);
        continue;
      }
      const hit = cache.get(name);
      if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) {
        rows[index] = hit;
        continue;
      }

      let parsed;
      try {
        parsed = JSON.parse(await readFile(path, "utf8"));
      } catch {
        // Skip an unreadable snapshot rather than failing the whole listing.
        cache.delete(name);
        continue;
      }
      const row = {};
      for (const field of fields) {
        row[field] = parsed[field] === undefined ? null : parsed[field];
      }
      const entry = { name, mtimeMs: info.mtimeMs, size: info.size, row };
      cache.set(name, entry);
      rows[index] = entry;
    }
  });
  await Promise.all(workers);
  return rows.filter((row) => row !== undefined);
}
