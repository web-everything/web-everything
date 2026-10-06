/**
 * @file scripts/lib/daemon-last-good.mjs
 * @description x5wbsbc (epic #4075/#3383) — "a failed daemon update must never block delivery". Operator ruling,
 *   Sat 2026-09-26: "fallback on last working version rather than block delivery".
 *
 *   A daemon clone is rebuilt from `origin/main` (+ overlays) by `daemon-rebuild.mjs`, gated behind a live smoke.
 *   When that smoke rejects the new build, the clone STAYS on the build it is already running — the last one a
 *   smoke passed (`state.adopted.head`). Before this card, every dispatch chokepoint then refused as stale
 *   (`main-staleness.mjs#assertMainNotStale`: "behind origin/main — refusing"), so a single bad main commit, a
 *   bad overlay, or a broken smoke HARNESS stopped all review/fix dispatch until a human stepped in (live
 *   2026-09-26 12:17-12:40 ET on `wev-review-daemon`: every rebuild `smoke-rejected`, sticky).
 *
 *   This module is the ONE read both sides share:
 *   - `main-staleness.mjs#assertMainNotStale` asks {@link lastGoodForClone}: is this managed clone's HEAD the
 *     last smoke-verified build, with a clean tree? Then it dispatches from it instead of refusing — and past
 *     {@link lastGoodMaxAgeMs} (default 24 h) of being held it says so loudly, but STILL dispatches.
 *   - `daemon-rebuild.mjs` writes `state.held` (why, since when, which checks failed) whenever a smoke failure
 *     keeps the clone on its last-good build, and clears it on the next adoption; the health watch's
 *     `daemon-held-on-last-good` sign reads the same record.
 *
 *   Deliberately import-light (node builtins and the standalone clone-layout helper only):
 *   `main-staleness.mjs` imports this, and `daemon-rebuild.mjs` imports `main-staleness.mjs`, so importing `daemon-overlays.mjs` (→ `daemon-self-sync.mjs` →
 *   `daemon-rebuild.mjs`) from here would close an import cycle. {@link cloneKeyOf} therefore re-states
 *   `daemon-overlays.mjs#cloneKey`'s hash using the shared canonical root; a test pins their values.
 */

import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalCloneRoot } from './daemon-clone-layout.mjs';

/** Env var pinning the rebuild-state root (same one `daemon-rebuild.mjs` uses). */
export const WE_DAEMON_STATE_DIR_ENV = 'WE_DAEMON_STATE_DIR';

/** Same env var as `queue-store.mjs#STATE_ROOT_ENV` / `pinnedStateRoot` (re-stated, not imported — see this
 *  file's own "import-light" header note; a unit test pins the two names to the same value, same convention
 *  as {@link cloneKeyOf} below). */
export const CONVEYOR_STATE_ROOT_ENV = 'CONVEYOR_STATE_ROOT';

/** Env override for how long a clone may be held on its last-good build before the staleness guard ALERTS
 *  (it keeps dispatching either way — the operator's ruling). */
export const LAST_GOOD_MAX_AGE_ENV = 'WE_DAEMON_LAST_GOOD_MAX_AGE_MS';
export const DEFAULT_LAST_GOOD_MAX_AGE_MS = 24 * 60 * 60_000;

/** Same env + default as `daemon-rebuild.mjs`'s `REBUILD_LEASE_STALE_ENV` / `DEFAULT_REBUILD_LEASE_STALE_MS`
 *  (re-stated, not imported — see the file header's import-cycle note). */
export const REBUILD_LEASE_STALE_ENV = 'WE_DAEMON_REBUILD_LEASE_STALE_MS';
export const REBUILD_LEASE_STALE_MS_DEFAULT = 20 * 60_000;

/** `<WE_DAEMON_STATE_DIR || ~/.claude/daemon-self-sync-state>`. */
export function daemonStateDir(env = process.env) {
  return (env && env[WE_DAEMON_STATE_DIR_ENV]) || join(homedir(), '.claude', 'daemon-self-sync-state');
}

/**
 * Where a daemon clone's conveyor runtime state lives (#4052): the operator's `CONVEYOR_STATE_ROOT` pin when
 * set, else `<daemonStateDir>/conveyor-state` — OUTSIDE every git tree, next to the rebuild's own state. THE
 * ONE definition every #4052 daemon-state-root reader shares (`we:scripts/lib/daemon-rebuild.mjs` re-exports
 * this exact function rather than redefining it; `we:scripts/conveyor/run-scorecard-store.mjs` and
 * `we:scripts/conveyor/health-watch-section.mjs` both import it — the latter directly from HERE, not from
 * `daemon-rebuild.mjs`, so pulling in the health watch's state-root resolution never drags in
 * `daemon-rebuild.mjs`'s much heavier build/smoke/child_process import graph; see this file's own "import-light"
 * header note — the same reason `daemon-rebuild.mjs` itself was kept out of `main-staleness.mjs`'s reach).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function daemonConveyorStateRoot(env = process.env) {
  const v = env?.[CONVEYOR_STATE_ROOT_ENV];
  const pinned = v && String(v).trim() ? resolvePath(String(v).trim()) : null;
  return pinned ?? join(daemonStateDir(env), 'conveyor-state');
}

/** Same value as `daemon-overlays.mjs#cloneKey` (sha256 of the canonical logical root, 16 hex) — see the file header. */
export function cloneKeyOf(root) {
  return createHash('sha256').update(canonicalCloneRoot(root)).digest('hex').slice(0, 16);
}

/** @returns {number} */
export function lastGoodMaxAgeMs(env = process.env) {
  const n = Number(env?.[LAST_GOOD_MAX_AGE_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_LAST_GOOD_MAX_AGE_MS;
}

/** Read `<stateDir>/<cloneKey>.rebuild.json`; `null` when missing or unreadable (never throws). */
export function readRebuildStateFile(root, env = process.env) {
  try {
    return JSON.parse(readFileSync(join(daemonStateDir(env), `${cloneKeyOf(root)}.rebuild.json`), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * PURE: is the clone HELD on its last smoke-verified build?
 * `onLastGood` needs all four: a recorded `adopted.head`, HEAD equal to it, a clean tree (a modified tree is not
 * the build the smoke verified), AND the rebuild actually holding the clone there — a `state.held` record (a
 * smoke failure kept it) or a `state.building` lease younger than {@link REBUILD_LEASE_STALE_MS_DEFAULT} (a
 * candidate smoke is in flight — an older record is a leftover from a crashed/unreleased build, not a hold;
 * same window as `daemon-rebuild.mjs#buildLeaseIsLive`, same env override). A clone that is merely
 * behind because `origin/main` moved since its last rebuild is NOT held: the staleness guard must still refuse
 * it, so `daemon-self-sync.mjs#withSelfSync` re-syncs and restarts within the same tick (#3383 I-18) instead of
 * dispatching off stale code until the next interval. `heldSince`/`ageMs`/`overAge` come from `state.held`
 * when recorded; with no `held` record the age is unknown (`null`, never over).
 * @param {{headSha:string|null, state:object|null, dirty?:boolean, nowMs:number, maxAgeMs:number}} o
 * @returns {{onLastGood:boolean, lastGood:string|null, held:object|null, heldSince:string|null,
 *   ageMs:number|null, overAge:boolean}}
 */
export function decideLastGood({ headSha, state, dirty = false, nowMs, maxAgeMs, leaseStaleMs = REBUILD_LEASE_STALE_MS_DEFAULT }) {
  const lastGood = state?.adopted?.head ?? null;
  const held = state?.held ?? null;
  const leaseStartedMs = Date.parse(state?.building?.startedAt || '');
  const building = Number.isFinite(leaseStartedMs) && nowMs - leaseStartedMs <= leaseStaleMs;
  const holding = !!held || building;
  const onLastGood = !!(lastGood && headSha && headSha === lastGood && !dirty && holding);
  const sinceMs = Date.parse(held?.since || '');
  const ageMs = Number.isFinite(sinceMs) ? Math.max(0, nowMs - sinceMs) : null;
  return {
    onLastGood,
    lastGood,
    held,
    heldSince: held?.since ?? null,
    ageMs,
    overAge: onLastGood && ageMs != null && ageMs > maxAgeMs,
  };
}

/**
 * IO shell over {@link decideLastGood} for one clone.
 * @param {{root:string, headSha:string|null, dirty?:boolean, env?:NodeJS.ProcessEnv, now?:number,
 *   readState?:typeof readRebuildStateFile}} o
 */
export function lastGoodForClone({
  root, headSha, dirty = false, env = process.env, now = Date.now(), readState = readRebuildStateFile,
}) {
  return decideLastGood({
    headSha, state: readState(root, env), dirty, nowMs: now, maxAgeMs: lastGoodMaxAgeMs(env),
    leaseStaleMs: Number(env?.[REBUILD_LEASE_STALE_ENV]) > 0 ? Number(env[REBUILD_LEASE_STALE_ENV]) : REBUILD_LEASE_STALE_MS_DEFAULT,
  });
}

/** Env knob: how long a managed clone may keep dispatching through review-path lag WHILE its rebuild is running
 *  (measured from its last adoption, `state.adopted.at`). `0` turns the grace off. */
export const STALE_GUARD_REBUILD_GRACE_ENV = 'WE_STALE_GUARD_REBUILD_GRACE_MS';
export const DEFAULT_STALE_GUARD_REBUILD_GRACE_MS = 60 * 60_000;

/** @returns {number} the grace in ms (0 = off). */
export function staleGuardRebuildGraceMs(env = process.env) {
  const raw = env?.[STALE_GUARD_REBUILD_GRACE_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_STALE_GUARD_REBUILD_GRACE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_STALE_GUARD_REBUILD_GRACE_MS;
}

/**
 * PURE: may a managed clone that is behind on its dispatch path still dispatch because a rebuild of it is
 * running right now? Live 2026-10-04 (`wev-review-daemon`, PRs #3923/#3924): the rebuild smoke ran for many
 * minutes under host load while main moved, and every review refused in the meantime. The grace is BOUNDED:
 * it needs a live build lease (`state.building`, younger than the lease-stale window, owner pid alive) AND a
 * last adoption (`state.adopted.at`) no older than `graceMs` — so a rebuild that keeps failing cannot hold the
 * guard open forever. Anything unknown (no lease, no adoption time, grace 0) ⇒ no grace (the guard refuses).
 * @param {{state:object|null, nowMs:number, graceMs:number, leaseStaleMs?:number,
 *   ownerAlive?:(building:object)=>boolean}} o
 * @returns {{grace:boolean, reason:string, target?:string|null, buildAgeMs?:number, sinceAdoptMs?:number}}
 */
export function decideRebuildGrace({
  state, nowMs, graceMs, leaseStaleMs = REBUILD_LEASE_STALE_MS_DEFAULT, ownerAlive = () => true,
}) {
  if (!(graceMs > 0)) return { grace: false, reason: 'grace-off' };
  const b = state?.building;
  const startedMs = Date.parse(b?.startedAt || '');
  if (!b || !Number.isFinite(startedMs)) return { grace: false, reason: 'no-build-running' };
  const buildAgeMs = Math.max(0, nowMs - startedMs);
  if (buildAgeMs > leaseStaleMs) return { grace: false, reason: 'build-lease-stale', buildAgeMs };
  let alive = false;
  try { alive = !!ownerAlive(b); } catch { alive = false; }
  if (!alive) return { grace: false, reason: 'build-owner-gone', buildAgeMs };
  const adoptedMs = Date.parse(state?.adopted?.at || '');
  if (!Number.isFinite(adoptedMs)) return { grace: false, reason: 'no-adoption-time', buildAgeMs };
  const sinceAdoptMs = Math.max(0, nowMs - adoptedMs);
  if (sinceAdoptMs > graceMs) return { grace: false, reason: 'grace-expired', buildAgeMs, sinceAdoptMs };
  return { grace: true, reason: 'rebuild-in-progress', target: b.target ?? null, buildAgeMs, sinceAdoptMs };
}

/** Same-host lease owner liveness (`daemon-rebuild.mjs#buildLeaseIsLive`'s rule, re-stated — import cycle). */
function leaseOwnerAlive(building) {
  if (building.host && building.host !== hostname()) return true;
  if (!Number.isInteger(building.pid)) return false;
  try { process.kill(building.pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

/** IO shell over {@link decideRebuildGrace} for one clone. Never throws (an error ⇒ no grace). */
export function rebuildGraceForClone({
  root, env = process.env, now = Date.now(), readState = readRebuildStateFile, ownerAlive = leaseOwnerAlive,
}) {
  try {
    return decideRebuildGrace({
      state: readState(root, env), nowMs: now, graceMs: staleGuardRebuildGraceMs(env), ownerAlive,
      leaseStaleMs: Number(env?.[REBUILD_LEASE_STALE_ENV]) > 0 ? Number(env[REBUILD_LEASE_STALE_ENV]) : REBUILD_LEASE_STALE_MS_DEFAULT,
    });
  } catch {
    return { grace: false, reason: 'unreadable' };
  }
}
