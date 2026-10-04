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
import { readdirSync } from 'node:fs';
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
