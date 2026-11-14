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
  if (rebuilding) return { run: false, reason: 'rebuilding' };
  if (leaseHeldByOther) return { run: false, reason: 'lease-held' };
  if (!Number.isFinite(looseCount)) return { run: false, reason: 'count-unreadable' };
  if (looseCount > threshold) return { run: true, reason: 'loose-over-threshold' };
  if (!Number.isFinite(lastRunAt) || now - lastRunAt > intervalMs) return { run: true, reason: 'interval-elapsed' };
  return { run: false, reason: 'not-due' };
}

async function defaultRun(args, { timeoutMs }) {
  const { stdout } = await execFileP('git', args, { timeout: timeoutMs, maxBuffer: 1 << 20 });
  return stdout;
}

/** IO runner. Never throws. `run(args, {timeoutMs})` is injected for tests. */
export async function runCloneMaintenance({
  clone, now, log = console, run = defaultRun, timeoutMs = GC_TIMEOUT_MS,
  readLastRun = () => null, writeLastRun = () => {}, rebuilding = false, leaseHeldByOther = () => false,
} = {}) {
  try {
    if (rebuilding) return { ran: false, reason: 'rebuilding' };
    if (leaseHeldByOther()) return { ran: false, reason: 'lease-held' };
    const out = await run(['-C', clone, 'count-objects', '-v'], { timeoutMs });
    const looseCount = Number(/^count:\s*(\d+)/m.exec(String(out))?.[1]);
    const plan = planCloneMaintenance({ looseCount, lastRunAt: readLastRun(), now });
    if (!plan.run) return { ran: false, reason: plan.reason };
    try {
      await run(['-C', clone, 'gc', '--auto', '--quiet'], { timeoutMs });
    } catch (e) {
      log.error?.(`daemon-rebuild: clone maintenance gc failed (non-fatal): ${String(e?.code || e?.message || e).slice(0, 120)}`);
      return { ran: false, reason: 'gc-failed' };
    }
    writeLastRun(now);
    log.error?.(`daemon-rebuild: clone maintenance ran git gc --auto (${plan.reason}, ${looseCount} loose objects before)`);
    return { ran: true, reason: plan.reason, looseCount };
  } catch (e) {
    try { log.error?.(`daemon-rebuild: clone maintenance skipped (non-fatal): ${String(e?.message || e).slice(0, 120)}`); } catch { /* log must not throw */ }
    return { ran: false, reason: 'error' };
  }
}

/** rebuild.mjs hook: after a successful adopt. Another live owner's build lease blocks it. */
export async function maybeMaintainClone({ root, stEnv, log, now, lease, readState }) {
  const stamp = join(root, '.git', STAMP);
  return runCloneMaintenance({
    clone: root, now: now(), log,
    readLastRun: () => { try { return Number(JSON.parse(readFileSync(stamp, 'utf8')).lastRunAt); } catch { return null; } },
    writeLastRun: (t) => { try { writeFileSync(stamp, JSON.stringify({ lastRunAt: t })); } catch { /* best effort */ } },
    leaseHeldByOther: () => {
      const b = readState()?.building;
      return !!b && b.token !== lease?.token && buildLeaseIsLive(b, { env: stEnv, nowMs: now() });
    },
  });
}
