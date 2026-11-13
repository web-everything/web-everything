/**
 * lane-pool-scan.mjs — a never-throwing host-wide lane-pool walk, used by the health watch's `laneVerifyMarkers`
 * probe. (`verify-dispatch.mjs` and `lease-reaper.mjs` still carry their own copy, fixed for the same incident
 * by PR #3902; folding them onto this helper is a follow-up, not done here to avoid conflicting with it.)
 *
 * WHY THIS EXISTS (live incident 2026-10-04 13:36Z). A plain FILE appeared at the pool root —
 * `~/workspace/.lanes/.metadata_never_index`, the macOS "never index this tree" sentinel dropped to cool a hot
 * `fseventsd`/Spotlight. Both daemons walked the root with `readdirSync(root).filter(name =>
 * laneIndicesIn(join(root, name)).length > 0)`, and `laneIndicesIn` called `readdirSync` on EVERY entry — so the
 * one file threw `ENOTDIR` and failed the WHOLE sweep, every tick. The verify daemon logged
 * "tick failed (non-fatal)" 50+ times and dispatched nothing: every `verify-lane request` since was stranded at
 * `running`, and five fix/build sessions polled `check --wait=540000` against markers nothing would ever settle
 * (PR #3890's fixer: 9 wait-timeouts, 80+ minutes).
 *
 * The rule here: one unreadable / non-directory entry is skipped, never fatal to the walk. A pool is a directory
 * holding `lane-N` children; anything else at the root (sentinel files, `.DS_Store`, a dangling symlink, a dir
 * we cannot read) is simply not a pool.
 */
import { readdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lane indices (`lane-N` children) under `poolDir`, sorted. `[]` for a missing path, a non-directory, or any
 * unreadable entry — never throws.
 * @param {string} poolDir
 * @param {{readdir?: typeof readdirSync}} [io]
 * @returns {number[]}
 */
export function laneIndicesIn(poolDir, { readdir = readdirSync } = {}) {
  let names;
  try { names = readdir(poolDir); } catch { return []; }
  return names
    .filter((d) => /^lane-\d+$/.test(d))
    .map((d) => Number(d.slice(5)))
    .sort((a, b) => a - b);
}

/**
 * Pool names under `poolRoot` that hold at least one lane, sorted. Non-pool entries (files, empty dirs, scratch
 * clones) are skipped; a missing or unreadable root is `[]`. Never throws.
 * @param {string} poolRoot
 * @param {{readdir?: typeof readdirSync}} [io]
 * @returns {string[]}
 */
export function poolsWithLanes(poolRoot, io = {}) {
  const readdir = io.readdir || readdirSync;
  let names;
  try { names = readdir(poolRoot); } catch { return []; }
  return names.filter((name) => laneIndicesIn(join(poolRoot, name), { readdir }).length > 0).sort();
}

/**
 * Partial hand-off from a RUNNING whole-pool acquirability scan to the callers waiting on its lock (live
 * 2026-11-13: review jobs sat out a 90-lane scan for their whole --wait-ms while 72 lanes were free). The lock
 * holder publishes the lanes it has proven acquirable so far into its own lock dir; a waiter takes them as
 * CANDIDATES without running any git itself. A candidate is never trusted: the caller still claims it (atomic
 * lease) and re-verifies dirty/ahead fresh before handing it out. The file lives in the lock dir, so it dies
 * with the lock, and carries the owner's identity so a later holder's waiters never read an earlier one's list.
 */
const sameOwner = (a, b) => !!a && !!b && a.pid === b.pid && a.host === b.host && a.startedAt === b.startedAt;

export function publishPartialFree(lockDir, owner, laneDirs) {
  const file = join(lockDir, 'partial.json');
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ v: 1, owner: { pid: owner.pid, host: owner.host, startedAt: owner.startedAt }, lanes: laneDirs }) + '\n');
    renameSync(tmp, file);
  } catch { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } } // best effort: waiters just keep waiting
}

export function readPartialFree(lockDir, owner) {
  try {
    const c = JSON.parse(readFileSync(join(lockDir, 'partial.json'), 'utf8'));
    if (!c || c.v !== 1 || !Array.isArray(c.lanes) || !sameOwner(c.owner, owner)) return [];
    return c.lanes.filter((d) => typeof d === 'string');
  } catch { return []; }
}
