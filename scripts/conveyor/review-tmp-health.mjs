// Per-tick backstop for abandoned read-only review checkouts and their backlog caches.
import { lstatSync, readdirSync, readFileSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { readBusyTopLevel } from './tmp-sweep.mjs';
import { isReviewScratchName, reviewScratchOwnerPath } from '../lib/review-scratch.mjs';
const positive = (v, fallback) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
};
function bytes(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + bytes(join(path, name)), 0);
}
export function sweepReviewTmp({ tmpRoot, config = {}, now = Date.now(), busy, dryRun = false, log = console.error } = {}) {
  const ttlMs = positive(config.tmp?.reviewSeatTtlMin, 120) * 60000;
  const maxBytes = positive(config.tmp?.backlogIndexMaxMb, 2048) * 1024 ** 2;
  const result = { directories: 0, files: 0, bytesFreed: 0, busy: 0, errors: 0 };
  let busyScanned = busy !== undefined;
  const cache = [];
  for (const name of readdirSync(tmpRoot)) {
    const path = join(tmpRoot, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory()) continue; // never follow a top-level symlink
      if (isReviewScratchName(name)) {
        if (now - st.mtimeMs < ttlMs) continue;
        let owner;
        try { owner = JSON.parse(readFileSync(reviewScratchOwnerPath(path), 'utf8')).pid; } catch { /* legacy checkout */ }
        if (alive(owner)) { result.busy++; continue; }
        // lsof is expensive. Observe once, only when an expired candidate needs it.
        // Unknown observation preserves checkouts without preventing cache capping.
        if (!busyScanned) {
          busyScanned = true;
          try { busy = readBusyTopLevel(tmpRoot); } catch { busy = null; }
        }
        if (!busy || busy.has(name)) { result.busy++; continue; }
        const size = bytes(path);
        if (!dryRun) {
          rmSync(path, { recursive: true, force: true });
          rmSync(reviewScratchOwnerPath(path), { force: true });
        }
        result.directories++; result.bytesFreed += size;
      } else if (/^we-backlog-index-[\w-]+$/.test(name)) {
        for (const file of readdirSync(path)) {
          const entry = join(path, file); const info = lstatSync(entry);
          if (info.isFile()) cache.push({ path: entry, size: info.size, mtime: info.mtimeMs });
        }
      }
    } catch { result.errors++; }
  }
  let total = cache.reduce((n, f) => n + f.size, 0);
  for (const file of cache.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path))) {
    if (total <= maxBytes) break;
    try {
      if (!dryRun) rmSync(file.path, { force: true });
      total -= file.size; result.files++; result.bytesFreed += file.size;
    } catch { result.errors++; }
  }
  log(`review-tmp: ${dryRun ? 'would free' : 'freed'} ${result.bytesFreed} bytes, ${result.directories} directories, ${result.files} cache files; busy ${result.busy}, errors ${result.errors}`);
  return result;
}
export function probeDiskSpace({ path = process.cwd(), statfs = statfsSync } = {}) {
  // Probe the checkout's filesystem: on macOS this is the writable data volume.
  const stat = statfs(path);
  return { freeGb: Number(stat.bavail) * Number(stat.bsize) / 1024 ** 3 };
}
