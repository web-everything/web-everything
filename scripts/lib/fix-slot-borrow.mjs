/**
 * @file scripts/lib/fix-slot-borrow.mjs
 * @description Card 87 — a fix that would otherwise WAIT for the fixer cap may borrow a FREE builder slot.
 *
 * WHEN IT FIRES (all must hold; the first that fails is the logged reason the fix keeps waiting):
 *   1. `fixDispatch.borrowBuildSlots` is `on` (product default OFF; our config ON — see `dispatch-throttle.mjs`).
 *   2. The caller only asks when the FIXER CAP (`fix-cap`) is the blocker. A scope-overlap wait never reaches the
 *      throttle (the planner refuses it first), so it keeps waiting; a host-load refusal is not a cap and is not asked.
 *   3. The fix has waited >= `borrowAfterMinutes` on the fixer cap (first deferral is kept in a small durable ledger;
 *      a gap with no deferral resets it, so a PR that left the cap-blocked set starts over).
 *   4. The chosen executor has a launcher in this checkout (`launcherAvailable`).
 *   5. The host-load gate admits (same `maxLoadPerCore` as every other launch).
 *   6. The builder has a FREE slot in the executor's class (Claude cap / external cap, the build daemon's own caps).
 *      Counted CONSERVATIVELY: every live build claim (its executor is not recorded on the claim) and every live
 *      borrowed fix of that class occupies a slot. It only takes a slot that is free NOW, so it never pre-empts or
 *      stops a build; the build daemon then counts the borrowed fix against that class (`borrowed` claim meta).
 *
 * A borrowed fix is a NORMAL fix (same claim, brief, review). Only the launcher/executor differ; the result is tagged
 * with reason {@link BORROW_REASON}.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { BUILD_DISPATCH_POLICY } from '../conveyor/build-dispatch-policy.mjs';
import { hostLoadGate, isBorrowedRunnerDead, isPidAlive, resolveFixBorrowSettings, resolveMaxLoadPerCore } from './dispatch-throttle.mjs';

export const BORROW_REASON = 'borrowed-build-slot';
/** A PR not deferred on the cap for this long starts its wait over. */
export const BORROW_WAIT_GAP_MS = 20 * 60_000;

/** The build daemon's executor class for a borrow executor: only `claude` shares the Claude cap. */
export const borrowClass = (executor) => (executor === 'claude' ? 'claude' : 'external');
/** The executor name the build daemon's planner counts (`codex`/`antigravity` are external, `claude` is Claude). */
export const builderExecutorFor = (executor) => (executor === 'claude' ? 'claude' : executor === 'codex' ? 'codex' : 'antigravity');

/** Borrowed launches that ended without a push (failed / no-change) this many times inside the window stop borrowing for
 *  that PR: it falls back to the normal fixer queue. */
export const BORROW_MAX_UNPRODUCTIVE = 2;
export const BORROW_FAILURE_WINDOW_MS = 60 * 60_000;

export const defaultBorrowOutcomePath = () => join(resolveCoordinationRoot(), 'fix-borrow-outcomes.json');

/** Durable per-PR record of how borrowed launches ended: `{ "<repo>#<pr>": [{at, outcome, reason}] }`. */
export function fileOutcomeStore(path = defaultBorrowOutcomePath()) {
  return fileLedger(path);
}

/** Record one borrowed launch's end. `pushed` clears the PR's history; anything else is appended (last 10 kept). */
export function recordBorrowOutcome({ repo, pr, outcome, reason = '', now = Date.now(), store = fileOutcomeStore() }) {
  const t = store.read() ?? {};
  const k = `${repo ?? 'we'}#${pr}`;
  if (outcome === 'pushed') delete t[k];
  else t[k] = [...(t[k] ?? []), { at: now, outcome, reason: String(reason).slice(0, 300) }].slice(-10);
  store.write(t);
}

/** Pure: the unproductive borrowed launches for this PR inside the window. */
export function recentBorrowFailures(table, { repo, pr, now = Date.now(), windowMs = BORROW_FAILURE_WINDOW_MS } = {}) {
  return (table?.[`${repo ?? 'we'}#${pr}`] ?? []).filter((o) => o && o.outcome !== 'pushed' && now - Number(o.at) <= windowMs);
}

export const defaultBorrowLedgerPath = () => join(resolveCoordinationRoot(), 'fix-cap-waits.json');

function fileLedger(path) {
  return {
    read() { try { const v = JSON.parse(readFileSync(path, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } },
    write(v) { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(v), { mode: 0o600 }); } catch { /* best-effort: a lost ledger only restarts the wait */ } },
  };
}

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.floor(n) : d; };

/** The build daemon's caps, from the same env knobs it reads (flags cannot be seen from here). */
export function resolveBuilderCaps(env = process.env) {
  return {
    claude: num(env?.WE_BUILD_DAEMON_MAX_CONCURRENT, BUILD_DISPATCH_POLICY.maxConcurrentBuilds),
    external: num(env?.WE_BUILD_DAEMON_MAX_CONCURRENT_EXTERNAL, BUILD_DISPATCH_POLICY.maxConcurrentExternalBuilds),
  };
}

/**
 * ONE gate per daemon pass (shared across repos) so slots taken earlier in the pass are seen by later PRs.
 * `consider({repo, pr})` -> `{borrow:true, executor, reason, waitedMinutes}` | `{borrow:false, why}`.
 * `clear({repo, pr})` forgets a PR's wait (it dispatched normally).
 */
export function createFixBorrowGate({
  env = process.env, settings = resolveFixBorrowSettings({ env }), now = () => Date.now(),
  ledger = fileLedger(defaultBorrowLedgerPath()),
  listBuildClaims = () => [], listFixClaims = () => [], caps = resolveBuilderCaps(env),
  loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length, alive = isPidAlive,
  outcomes = fileOutcomeStore(),
  launcherAvailable = (executor) => executor === 'claude',
} = {}) {
  let table = null;
  const taken = { claude: 0, external: 0 };
  const load = () => { if (table === null) { try { table = ledger.read() ?? {}; } catch { table = {}; } } return table; };
  const key = ({ repo, pr }) => `${repo ?? 'we'}#${pr}`;
  return {
    settings,
    clear(id) { const t = load(); if (t[key(id)]) { delete t[key(id)]; try { ledger.write(t); } catch { /* best-effort */ } } },
    consider(id) {
      if (!settings.enabled) return { borrow: false, why: 'borrow-off' };
      let failures = [];
      try { failures = recentBorrowFailures(outcomes.read() ?? {}, { ...id, now: now() }); } catch { /* unreadable: borrow as before */ }
      if (failures.length >= BORROW_MAX_UNPRODUCTIVE) {
        const last = failures.at(-1);
        return { borrow: false, why: `borrowed launch ended without a push ${failures.length}x for this PR (last: ${last.outcome}${last.reason ? ` - ${last.reason}` : ''}); using the normal fixer queue` };
      }
      const t = load();
      const at = now();
      const prev = t[key(id)];
      const first = prev && at - prev.last <= BORROW_WAIT_GAP_MS ? prev.first : at;
      t[key(id)] = { first, last: at };
      try { ledger.write(t); } catch { /* best-effort */ }
      const waitedMinutes = (at - first) / 60_000;
      if (waitedMinutes < settings.afterMinutes) {
        return { borrow: false, why: `waited ${waitedMinutes.toFixed(1)} of ${settings.afterMinutes} min on the fixer cap` };
      }
      const { executor } = settings;
      if (!launcherAvailable(executor)) return { borrow: false, why: `no ${executor} fix launcher in this checkout` };
      let gate = { admit: true };
      try { gate = hostLoadGate({ load: loadavg(), cores: cpuCount(), maxLoadPerCore: resolveMaxLoadPerCore({ env }) }); } catch { /* fail open, like every load read */ }
      if (!gate.admit) return { borrow: false, why: gate.why };
      const klass = borrowClass(executor);
      let builds = 0; let borrowedLive = 0;
      try { builds = listBuildClaims().length; } catch { /* unreadable claims: assume none, the build daemon still caps */ }
      try { borrowedLive = listFixClaims().filter((c) => c?.meta?.borrowed && !isBorrowedRunnerDead(c, alive) && borrowClass(c.meta.borrowed.executor) === klass).length; } catch { /* as above */ }
      const free = caps[klass] - builds - borrowedLive - taken[klass];
      if (free <= 0) return { borrow: false, why: `no free ${klass} builder slot (cap ${caps[klass]}, ${builds} build(s), ${borrowedLive + taken[klass]} borrowed)` };
      taken[klass] += 1;
      return { borrow: true, executor, reason: BORROW_REASON, waitedMinutes: Math.floor(waitedMinutes) };
    },
  };
}
