/** @file scripts/lib/daemon-rebuild/lease.mjs — Lock waits, writer preference (rebuild starvation), and the
 * single-flight build lease. Split out of daemon-rebuild.mjs (move-only).
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { cloneKey } from '../daemon-overlays.mjs';
import { stateDir } from './state.mjs';
import { removeCandidate, candidateWorktreePath } from './candidate.mjs';

// ── rebuild starvation (live 2026-10-05 07:09-07:33 ET) ─────────────────────────────────────────────────────
// Two daemons share wev-review-daemon. The review daemon's tick runs ~10 min, so the fix daemon's 60s write-lock
// wait gave up EVERY tick (and vice versa): no rebuild at all for 20+ min, so a registered overlay fix never went
// live. After STARVE_ESCALATE_AFTER consecutive `tick-in-progress` give-ups the next attempt waits the longer
// starved wait. That wait is bounded by ticks already in flight: the writer reservation refuses every NEW read.
export const STARVE_ESCALATE_AFTER_ENV = 'WE_DAEMON_REBUILD_STARVE_ESCALATE_AFTER';
export const DEFAULT_STARVE_ESCALATE_AFTER = 2;
export const STARVED_LOCK_WAIT_ENV = 'WE_DAEMON_REBUILD_STARVED_WAIT_MS';
export const DEFAULT_STARVED_LOCK_WAIT_MS = 3 * 60_000;

function starvePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.starve.json`);
}

/** Consecutive `tick-in-progress` give-ups for this clone (missing/corrupt = 0). */
export function readRebuildStarvation(root, env = process.env) {
  try {
    const n = JSON.parse(readFileSync(starvePath(root, env), 'utf8'))?.count;
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

export function writeRebuildStarvation(root, count, env = process.env) {
  try {
    const file = starvePath(root, env);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ count, at: new Date().toISOString() })}\n`, 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort: a lost count only delays the escalation */ }
}

/** The write-lock wait for this attempt: the normal wait, or the starved wait once the clone has starved. */
export function starvationLockWaitMs(baseWaitMs, starvedCount, env = process.env) {
  const after = Number(env?.[STARVE_ESCALATE_AFTER_ENV]) > 0 ? Number(env[STARVE_ESCALATE_AFTER_ENV]) : DEFAULT_STARVE_ESCALATE_AFTER;
  const starved = Number(env?.[STARVED_LOCK_WAIT_ENV]) > 0 ? Number(env[STARVED_LOCK_WAIT_ENV]) : DEFAULT_STARVED_LOCK_WAIT_MS;
  return starvedCount >= after ? Math.max(baseWaitMs, starved) : baseWaitMs;
}

/** How long a tick-start rebuild waits for other daemons' ticks (read slots) to drain — env-tunable, see rebuildClone. */
export const REBUILD_LOCK_WAIT_ENV = 'WE_DAEMON_REBUILD_LOCK_WAIT_MS';
export const DEFAULT_REBUILD_LOCK_WAIT_MS = 60_000;

/** How long the write-lock wait is once a candidate has PASSED its smoke (or a passed candidate is waiting to be
 *  adopted) — longer than {@link DEFAULT_REBUILD_LOCK_WAIT_MS}: a passing smoke is expensive to redo, and while
 *  this process waits, the writer reservation already refuses every NEW read slot, so the wait is bounded by the
 *  readers' in-flight ticks, never by a fresh one. Env-tunable. */
export const FINALIZE_LOCK_WAIT_ENV = 'WE_DAEMON_FINALIZE_LOCK_WAIT_MS';
export const DEFAULT_FINALIZE_LOCK_WAIT_MS = 180_000;

/** A passed-but-not-yet-adopted candidate older than this is ignored (its smoke is no longer fresh evidence). */
export const READY_MAX_AGE_ENV = 'WE_DAEMON_READY_MAX_AGE_MS';
export const DEFAULT_READY_MAX_AGE_MS = 2 * 60 * 60_000;

// ── single-flight build lease (PR #2731 review) ──────────────────────────────────────────────────────────────

/** Tokens of the builds THIS process is running right now — lets a process tell its own finished-but-unreleased
 *  lease (a release that could not take the write lock) from one still in flight. */
export const ACTIVE_BUILD_TOKENS = new Set();

/** How long a lease from a live pid (or another host) is honoured before it is treated as abandoned. Well past
 *  the slowest live smoke seen (~6 min) so a real build is never taken over mid-smoke. */
export const REBUILD_LEASE_STALE_ENV = 'WE_DAEMON_REBUILD_LEASE_STALE_MS';
export const DEFAULT_REBUILD_LEASE_STALE_MS = 20 * 60_000;

/**
 * Is `building` (a `state.building` lease record) held by a build that is still running? Same host + this pid:
 * only while its token is in {@link ACTIVE_BUILD_TOKENS}. Same host, other pid: while that pid is alive and the
 * lease is not aged. Other host: until it ages out. A record that cannot be read fails OPEN (not live) — the
 * lease is a courtesy against wasted, colliding smokes, and the unique candidate path is what keeps a takeover
 * from ever touching another attempt's tree.
 */
export function buildLeaseIsLive(building, { env = process.env, nowMs = Date.now() } = {}) {
  if (!building || typeof building !== 'object') return false;
  const staleMs = Number(env?.[REBUILD_LEASE_STALE_ENV]) > 0 ? Number(env[REBUILD_LEASE_STALE_ENV]) : DEFAULT_REBUILD_LEASE_STALE_MS;
  const startedMs = Date.parse(building.startedAt || '');
  if (!Number.isFinite(startedMs) || nowMs - startedMs > staleMs) return false;
  if (building.host !== hostname()) return true;
  if (building.pid === process.pid) return ACTIVE_BUILD_TOKENS.has(building.token);
  try { process.kill(building.pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

/**
 * Must be called UNDER the write lock with a freshly read `state`: take the single-flight build lease for
 * `plan`, tearing down an abandoned lease's leftover candidate first. Returns the lease, or `null` when a live
 * sibling build already holds it. Mutates `state.building`; the caller writes the state.
 */
export function claimBuildLease({ state, plan, root, run, env, nowMs }) {
  if (buildLeaseIsLive(state.building, { env, nowMs })) return null;
  if (state.building?.path && leaseOwnerIsGone(state.building)) removeCandidate({ root, path: state.building.path, run, env });
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`;
  const lease = {
    token, pid: process.pid, host: hostname(), startedAt: new Date(nowMs).toISOString(),
    target: plan.finalSha, inputsKey: plan.inputsKey, path: candidateWorktreePath(root, env, token),
  };
  state.building = lease;
  ACTIVE_BUILD_TOKENS.add(token);
  return lease;
}

/** May an abandoned lease's candidate be deleted? Only when its owner provably is not still reading it: this
 *  process (none of our builds is running — see {@link buildLeaseIsLive}), or a dead pid on this host. An AGED
 *  lease from a still-live pid (a smoke slower than the stale limit) or another host is taken over, but its tree
 *  is left alone — the new attempt uses its own unique path, so the two never collide. */
function leaseOwnerIsGone(building) {
  if (building.host !== hostname()) return false;
  if (building.pid === process.pid) return !ACTIVE_BUILD_TOKENS.has(building.token);
  try { process.kill(building.pid, 0); return false; } catch (e) { return !!(e && e.code === 'ESRCH'); }
}

/** Under the write lock: drop `state.building` if it is still OUR lease (a takeover's newer lease is left alone). */
export function releaseBuildLease(state, lease) {
  if (state.building?.token === lease.token) state.building = null;
}

