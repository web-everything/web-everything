/**
 * @file scripts/lib/daemon-rebuild/clone-maintenance.mjs
 * @description B13: daemon clones fetched on every rebuild and never packed (loose objects reached GBs). After a
 *   SUCCESSFUL adopt, run `git gc --auto --quiet` (default prune expiry; never --prune=now, so a detached worktree
 *   index never loses an object). Pure plan + injected-IO runner; every failure is non-fatal and logged once.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildLeaseIsLive } from './lease.mjs';
import { withWriteLock } from '../daemon-clone-lock.mjs';

const execFileP = promisify(execFile);
export const LOOSE_THRESHOLD = 5000;
export const INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GC_TIMEOUT_MS = 10 * 60 * 1000;
const STAMP = 'we-clone-maintenance.json';

/** Pure: should maintenance run now? Fails closed on an unreadable loose count. */
export function planCloneMaintenance({
  looseCount, lastRunAt, now, rebuilding = false, leaseHeldByOther = false,
  threshold = LOOSE_THRESHOLD, intervalMs = INTERVAL_MS,
} = {}) {
  if (rebuilding) return { run: false, why: 'rebuilding' };
  if (leaseHeldByOther) return { run: false, why: 'lease-held' };
  if (!Number.isFinite(looseCount)) return { run: false, why: 'count-unreadable' };
  if (looseCount > threshold) return { run: true, why: 'loose-over-threshold' };
  if (!Number.isFinite(lastRunAt) || now - lastRunAt > intervalMs) return { run: true, why: 'interval-elapsed' };
  return { run: false, why: 'not-due' };
}

// Git routing variables must not redirect maintenance to an object store outside the clone.
function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

async function defaultRun(args, { timeoutMs }) {
  const { stdout } = await execFileP('git', args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: cleanEnv() });
  return stdout;
}

/** IO runner. Never throws. `run(args, {timeoutMs})` is injected for tests. */
export async function runCloneMaintenance({
  clone, now, log = console, run = defaultRun, timeoutMs = GC_TIMEOUT_MS,
  readLastRun = () => null, writeLastRun = () => {}, rebuilding = false, leaseHeldByOther = () => false,
} = {}) {
  try {
    if (rebuilding) return { ran: false, why: 'rebuilding' };
    if (leaseHeldByOther()) return { ran: false, why: 'lease-held' };
    // The clone must own its object store: refuse a shared/alternate git dir (fail closed).
    const gitDir = String(await run(['-C', clone, 'rev-parse', '--git-dir', '--git-common-dir'], { timeoutMs })).trim().split('\n');
    if (gitDir.length !== 2 || gitDir[0] !== gitDir[1]) return { ran: false, why: 'shared-git-dir' };
    const out = await run(['-C', clone, 'count-objects', '-v'], { timeoutMs });
    const looseCount = Number(/^count:\s*(\d+)/m.exec(String(out))?.[1]);
    const plan = planCloneMaintenance({ looseCount, lastRunAt: readLastRun(), now });
    if (!plan.run) return { ran: false, why: plan.why };
    // The lease can appear while objects were being counted: re-check right before gc.
    if (leaseHeldByOther()) return { ran: false, why: 'lease-held' };
    try {
      // autoDetach=false keeps gc in the foreground so the timeout bounds it.
      await run(['-C', clone, '-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet'], { timeoutMs });
    } catch (e) {
      log.error?.(`daemon-rebuild: clone maintenance gc failed (non-fatal): ${String(e?.code || e?.message || e).slice(0, 120)}`);
      return { ran: false, why: 'gc-failed' };
    }
    writeLastRun(now);
    log.error?.(`daemon-rebuild: clone maintenance ran git gc --auto (${plan.why}, ${looseCount} loose objects before)`);
    return { ran: true, why: plan.why, looseCount };
  } catch (e) {
    try { log.error?.(`daemon-rebuild: clone maintenance skipped (non-fatal): ${String(e?.message || e).slice(0, 120)}`); } catch { /* log must not throw */ }
    return { ran: false, why: 'error' };
  }
}

/** rebuild.mjs hook: after a successful adopt. Holds the clone write lock (readers excluded) for the gc; an
 *  unreadable build state or lease counts as held (fail closed). */
export async function maybeMaintainClone({ root, stEnv, log, now, lease, readState, lockOpts = {} }) {
  const stamp = join(root, '.git', STAMP);
  const held = () => {
    try {
      const b = readState()?.building;
      return !!b && b.token !== lease?.token && buildLeaseIsLive(b, { env: stEnv, nowMs: now() }) !== false;
    } catch { return true; }
  };
  const locked = await withWriteLock(root, () => runCloneMaintenance({
    clone: root, now: now(), log, leaseHeldByOther: held,
    readLastRun: () => { try { return Number(JSON.parse(readFileSync(stamp, 'utf8')).lastRunAt); } catch { return null; } },
    writeLastRun: (t) => { try { writeFileSync(stamp, JSON.stringify({ lastRunAt: t })); } catch { /* best effort */ } },
  }), { ...lockOpts, waitMs: 1000 });
  return locked.ok ? locked.value : { ran: false, why: 'write-lock-busy' };
}
