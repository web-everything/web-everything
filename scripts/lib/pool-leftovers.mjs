/**
 * @file scripts/lib/pool-leftovers.mjs
 * @description Retention for everything a lane pool accumulates BESIDE its `lane-N` clones — loose logs,
 *   patches, scratch folders and stray clones agents left in the pool dir (~44 entries in the WE pool on
 *   2026-09-27), stale worktree metadata inside lanes, and old dispatch scratch dirs.
 *
 *   Rules (every one skips anything with a live process cwd inside it):
 *   - `lane-N`, dot-entries (the pool's own caches/locks), symlinks: never touched.
 *   - anything touched within {@link LEFTOVER_MAX_AGE_DAYS} days: kept.
 *   - `*.patch` / `*.diff`: copied into the salvage store and indexed FIRST, then removed (work, not litter).
 *   - other loose files (logs, txt, json): removed.
 *   - a directory that is a git clone: salvaged like a lane (verified bundle of any unique commits/edits,
 *     indexed) FIRST, then removed. A failed salvage keeps it.
 *   - any other directory: scratch, removed.
 *   - dispatch scratch dirs (`<workspace>/.operations/dispatch/<uuid>`) older than the same age and not the cwd
 *     of a live `claude agents` session: removed (backstop to `session-reaper.mjs`'s finished-session reap).
 *   - `git worktree prune` in every lane (metadata only; never removes a worktree that still exists).
 *
 * PURE: {@link classifyPoolLeftover}. IO: {@link sweepPoolLeftovers}.
 */
import { execFileSync } from 'node:child_process';
import { readGit } from './proc-read.mjs';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { resolveSalvageRoot, salvageLane, salvageStamp, appendSalvageIndex, readLiveCwds, pidsWithCwdIn } from './lane-salvage.mjs';

export const LEFTOVER_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * PURE: what to do with one pool-dir entry.
 * @param {{name:string, isDir:boolean, isSymlink:boolean, isGit:boolean, newestMtimeMs:number, liveCwd:boolean}} e
 * @returns {{action:'keep'|'delete'|'index-then-delete'|'salvage-then-delete', reason:string}}
 */
export function classifyPoolLeftover(e, { nowMs, maxAgeDays = LEFTOVER_MAX_AGE_DAYS }) {
  if (/^lane-\d+$/.test(e.name)) return { action: 'keep', reason: 'a pool lane' };
  if (e.name.startsWith('.')) return { action: 'keep', reason: 'pool bookkeeping (dot-entry)' };
  if (e.isSymlink) return { action: 'keep', reason: 'symlink' };
  if (e.liveCwd) return { action: 'keep', reason: 'a live process has its cwd inside' };
  const ageDays = (nowMs - e.newestMtimeMs) / DAY_MS;
  if (!(ageDays >= maxAgeDays)) return { action: 'keep', reason: `touched ${ageDays.toFixed(1)}d ago (< ${maxAgeDays}d)` };
  if (e.isDir && e.isGit) return { action: 'salvage-then-delete', reason: `stray clone, idle ${ageDays.toFixed(0)}d` };
  if (e.isDir) return { action: 'delete', reason: `scratch dir, idle ${ageDays.toFixed(0)}d` };
  if (/\.(patch|diff)$/i.test(e.name)) return { action: 'index-then-delete', reason: `loose patch, idle ${ageDays.toFixed(0)}d` };
  return { action: 'delete', reason: `loose file, idle ${ageDays.toFixed(0)}d` };
}

const tryGit = (dir, args) => { try { return readGit(args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }); } catch { return null; } };

function newestMtime(path, isDir, isGit) {
  let m = lstatSync(path).mtimeMs;
  const bump = (p) => { try { m = Math.max(m, statSync(p).mtimeMs); } catch { /* absent */ } };
  // A read-only `git status` rewrites `.git/index` (and the `.git` dir's mtime), so neither counts as activity —
  // only the HEAD reflog (a commit/checkout/reset) and the working tree's own entries, at any depth, do.
  if (isDir && isGit) { m = 0; bump(join(path, '.git', 'logs', 'HEAD')); }
  // Recurse into every descendant, not just the top level (#4272) — a directory whose own top-level entries
  // (and own lstat) have gone stale can still hold a genuinely fresh file several levels down. Missing that
  // aged the whole tree out and deleted it with no salvage step, an unrecoverable loss of real work.
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; /* unreadable */ }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      const p = join(dir, ent.name);
      bump(p);
      if (ent.isDirectory()) walk(p);
    }
  };
  if (isDir) walk(path);
  return m;
}

function sizeOf(path) {
  try { return Number(execFileSync('du', ['-sk', path], { encoding: 'utf8', timeout: 120_000 }).split(/\s+/)[0]) * 1024; } catch { return 0; }
}

/**
 * IO: sweep one pool dir (+ its lanes' worktree metadata, + the dispatch scratch root). `dryRun` reports only.
 * @returns {{actions:Array<{name:string, action:string, reason:string, bytes:number, done?:boolean, error?:string}>, bytesFreed:number, prunedLanes:number, dispatchRemoved:number}}
 */
export function sweepPoolLeftovers({
  poolDir, pool, dryRun = false, nowMs = Date.now(), maxAgeDays = LEFTOVER_MAX_AGE_DAYS,
  salvageRoot = resolveSalvageRoot(), dispatchRoot = null, liveAgents = null, branchRef = 'origin/main',
}) {
  const cwds = readLiveCwds();
  const live = (p) => (cwds === null ? true : pidsWithCwdIn(cwds, p).length > 0); // lsof unreadable ⇒ assume live
  const actions = [];
  let bytesFreed = 0;
  for (const name of existsSync(poolDir) ? readdirSync(poolDir) : []) {
    const path = join(poolDir, name);
    let st; try { st = lstatSync(path); } catch { continue; }
    const isSymlink = st.isSymbolicLink();
    const isDir = !isSymlink && st.isDirectory();
    const isGit = isDir && existsSync(join(path, '.git'));
    const cls = classifyPoolLeftover({
      name, isDir, isSymlink, isGit, newestMtimeMs: isSymlink || name.startsWith('.') || /^lane-\d+$/.test(name) ? nowMs : newestMtime(path, isDir, isGit),
      liveCwd: isDir && !/^lane-\d+$/.test(name) && !name.startsWith('.') && live(path),
    }, { nowMs, maxAgeDays });
    if (cls.action === 'keep') { if (!/^lane-\d+$/.test(name) && !name.startsWith('.')) actions.push({ name, ...cls, bytes: 0 }); continue; }
    const bytes = sizeOf(path);
    const row = { name, ...cls, bytes };
    actions.push(row);
    if (dryRun) { bytesFreed += bytes; continue; }
    try {
      if (cls.action === 'index-then-delete') {
        const stamp = salvageStamp(new Date(nowMs));
        const outDir = join(salvageRoot, pool, stamp, 'pool-leftovers');
        mkdirSync(outDir, { recursive: true });
        const dest = join(outDir, name);
        copyFileSync(path, dest);
        appendSalvageIndex(salvageRoot, {
          ts: new Date(nowMs).toISOString(), pool, lane: null, dir: null, stamp, outDir, bundle: null, patches: [dest],
          reason: `loose patch left in the pool dir (${name})`, lastHolder: null, branch: null, head: null, cards: cardsFromName(name),
          prs: [], changedFiles: [], refs: [], snapshots: [], landed: false, poolLeftover: name,
        });
      } else if (cls.action === 'salvage-then-delete') {
        salvageLane({ dir: path, lane: name, pool, branchRef, salvageRoot, now: new Date(nowMs), reason: `stray clone in the pool dir (${name})`, includeLocalBranches: true });
      }
      rmSync(path, { recursive: true, force: true });
      row.done = true;
      bytesFreed += bytes;
    } catch (e) {
      row.error = String(e?.message || e).split('\n')[0];
    }
  }
  // Worktree METADATA prune in every lane — only drops records whose directory is already gone.
  let prunedLanes = 0;
  for (const name of existsSync(poolDir) ? readdirSync(poolDir).filter((n) => /^lane-\d+$/.test(n)) : []) {
    const dir = join(poolDir, name);
    const before = tryGit(dir, ['worktree', 'list', '--porcelain']);
    if (before === null) continue;
    if (!/prunable/.test(before)) continue;
    if (!dryRun) tryGit(dir, ['worktree', 'prune']);
    prunedLanes++;
  }
  // Dispatch scratch backstop.
  let dispatchRemoved = 0;
  if (dispatchRoot && existsSync(dispatchRoot)) {
    const liveCwdsOfAgents = (liveAgents || []).map((a) => String(a?.cwd || ''));
    for (const id of readdirSync(dispatchRoot)) {
      const p = join(dispatchRoot, id);
      let st; try { st = statSync(p); } catch { continue; }
      if (!st.isDirectory() || (nowMs - st.mtimeMs) / DAY_MS < maxAgeDays) continue;
      if (liveAgents === null || liveCwdsOfAgents.some((c) => c === p || c.startsWith(p + sep)) || live(p)) continue;
      if (!dryRun) rmSync(p, { recursive: true, force: true });
      dispatchRemoved++;
    }
  }
  return { actions, bytesFreed, prunedLanes, dispatchRemoved };
}

function cardsFromName(name) {
  const m = /(\d{3,5}|x[a-z0-9]{5,7})/i.exec(name);
  return m ? [m[1]] : [];
}
