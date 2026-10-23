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
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { BUILD_DISPATCH_POLICY } from '../conveyor/build-dispatch-policy.mjs';
import { gateLaunch } from './resource-gate.mjs';
import { isBorrowedRunnerDead, isPidAlive, resolveFixBorrowSettings } from './dispatch-throttle.mjs';

import { pickChainRung } from './fix-executor-chain.mjs';
import { readSettings } from './settings-files.mjs';
import { readLockEntry, heartbeat } from '../readiness/file-locks.mjs';
// Keep fix-run's static graph independent of the dispatch wrappers: use the light claim store.
import { fixDispatchClaimRoot, fixDispatchResource } from '../conveyor/fix-claim-store.mjs';

const platformPreferences = () => {
  try { return JSON.parse(readFileSync(new URL('./delivery-platform-preferences.json', import.meta.url), 'utf8')); }
  catch { return {}; }
};

/** fix.executor: standard → shared platform preferences → declared repo settings → environment. */
export function resolveFixExecutorSetting({ env = process.env, platform = platformPreferences(), repo = readSettings() } = {}) {
  let result = { value: 'codex-first', source: 'default' };
  for (const [source, raw] of [['platform', platform?.fix?.executor], ['repo', repo?.fix?.executor], ['env', env?.WE_FIX_EXECUTOR]]) {
    if (['codex-first', 'claude', 'provider-routing'].includes(raw)) result = { value: raw, source };
  }
  return result;
}

/**
 * Pure; why this repair must run on Claude whatever `fix.executor` says, or null. The ONE list both the router
 * ({@link chooseFixExecutor}) and the fixer-cap borrow guard read, so a borrowed slot never bypasses these per-entry rules.
 */
export function claudeOnlyReason({ round = 1, takeover = false, rulingNotAddressed = false, mainFix = false, strongerModel = false, codexUnproductive = 0 } = {}) {
  if (takeover) return 'takeover round';
  // A ruling-not-addressed send-back runs on its own ladder rung (`launchTableFor`); only `claude --bg` applies that table.
  if (rulingNotAddressed) return 'ruling-not-addressed send-back';
  if (mainFix) return 'main-fix';
  if (codexUnproductive >= ROUTED_CODEX_MAX_UNPRODUCTIVE) return `codex unproductive on this head (${codexUnproductive} unproductive runs) → falls back to Claude`;
  if (strongerModel || round >= 3) return 'stronger-model rung';
  return null;
}

/** Pure; provider-routing leaves existing provider/borrow selection in control. */
export function chooseFixExecutor({ setting = { value: 'codex-first', source: 'default' }, launcherAvailable = false, chain, critical = false, ...entry } = {}) {
  const source = setting.source ?? 'default';
  const claude = (reason) => ({ executor: 'claude', reason, source });
  if (setting.value === 'claude') return claude('fix.executor=claude');
  if (setting.value === 'provider-routing') return claude('existing provider routing');
  const available = typeof launcherAvailable === 'function' ? launcherAvailable : executor => executor === 'codex' ? launcherAvailable : true;
  if (chain && setting.value === 'codex-first' && !entry.mainFix) {
    const trigger = entry.takeover ? 'takeover' : entry.rulingNotAddressed ? 'ruling-not-addressed'
      : entry.strongerModel || (entry.round ?? 1) >= 3 ? 'stronger-model' : null;
    return { ...pickChainRung({ chain: chain.value, trigger, codexUnproductive: entry.codexUnproductive,
      critical, criticalClaudeFromRung: chain.criticalClaudeFromRung, criticalSource: chain.criticalClaudeFromRungSource,
      launcherAvailable: available }), source: chain.source ?? 'default' };
  }
  const only = claudeOnlyReason(entry);
  if (only) return claude(only);
  if (!available('codex')) return claude('codex launcher unavailable, fallback');
  return { executor: 'codex', reason: 'codex-first ordinary repair', source };
}

export const formatFixExecutorLog = ({ executor, rung, policyRoute, reason, source }) =>
  `fix executor: ${executor}${rung ? ` rung=${rung} model=${policyRoute?.model ?? 'default'} effort=${policyRoute?.effort ?? 'default'}` : ''} (${reason}, source ${source})`;

/** Stamp routing separately from `borrowed`: builder accounting must never count this as a borrowed slot. */
export function stampFixExecutor({ repo, pr, kind = 'fix', owner, lockRoot = fixDispatchClaimRoot(), decision }) {
  const resource = fixDispatchResource({ repo, pr, kind });
  const claim = readLockEntry(lockRoot, resource);
  if (!claim || claim.owner !== owner) return false;
  return heartbeat(lockRoot, resource, owner, new Date().toISOString(), claim.pid ?? null,
    { ...claim.meta, fixExecutor: { executor: decision.executor, reason: decision.reason } });
}

/**
 * Adapt the CI-heal dispatch seam, retaining its claim, filled brief and dispatch sink bookkeeping.
 * Carry the repair kind to the launcher: card 5947 (live #5045, 2026-10-13).
 * Any non-Claude decision replaces the sink's provider and heal router. EVERY Claude outcome (fix.executor=claude,
 * provider-routing, main-fix, critical escalation, chain exhausted) leaves both in place, so it launches
 * exactly as before this routing existed: `routeDispatchProvider` (model/effort table, registry providers, probation
 * worker, injected `spawnAgent`) and `routeAvailableCiHeal` (including the native-Claude quota-hold refusal).
 */
export function createRoutedCiHealDispatch({ dispatch, route, createSinks, launchCodex, writePrompt, removePrompt,
  profileFor, stampExecutor = stampFixExecutor, staleBaseGate }) {
  return async (planned, options = {}) => {
    if (staleBaseGate) {
      let gate = null;
      try { gate = await staleBaseGate({ planned, repo: options.repo ?? planned.repo ?? 'we', root: options.root }); }
      catch (e) { console.error(`reconcile-fix-dispatch: PR #${planned.pr} stale-base gate failed open: ${String(e?.message ?? e)}`); }
      if (gate?.held) return { held: true, reason: gate.reason };
    }
    const decision = route({ ...planned, repo: options.repo ?? planned.repo ?? 'we', kind: 'ci-heal' });
    const nonClaude = decision.executor !== 'claude';
    const sinks = createSinks({ ...options, ...(nonClaude ? { provider: (request) => {
      console.error(`reconcile-fix-dispatch: PR #${planned.pr} ${formatFixExecutorLog(decision)}`);
      const profile = profileFor(options.repo ?? planned.repo ?? 'we');
      stampExecutor({ repo: options.repo ?? planned.repo ?? 'we', pr: planned.pr, kind: 'ci-heal',
        owner: request.claimOwner, lockRoot: request.claimRoot, decision });
      const promptFile = writePrompt(request.sessionSlug, request.prompt);
      try {
        const handle = launchCodex({ ...request, repairKind: 'ci-heal', cwd: options.root, promptFile, ref: planned.laneRef,
          mergeOnto: mergeOntoFor(planned),
          repo: profile.slug, laneRepo: profile.lanePoolRepo, claimRepo: options.repo ?? planned.repo ?? 'we',
          scope: planned.scope.join(','), policyRoute: decision.policyRoute ?? { provider: 'codex' } });
        request.reportWrapped?.(Number(String(handle).replace(/^pid:/, '')));
        return handle;
      } catch (error) { removePrompt(promptFile); throw error; }
    } } : {}) });
    if (!nonClaude) {
      // Observe the existing provider's actual choice without changing that choice.
      const entries = Object.entries(sinks);
      for (const [key, sink] of entries) sinks[key] = async (...args) => {
        const out = await sink(...args);
        if (!out?.held) console.error(`reconcile-fix-dispatch: PR #${planned.pr} ${formatFixExecutorLog({ ...decision, executor: out?.dispatch?.executor ?? 'claude' })}`);
        return out;
      };
    }
    return dispatch(nonClaude ? { ...planned, strongerModel: false } : planned, { ...options, sinks, ...(nonClaude ? { routeHeal: () => null } : {}) });
  };
}

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

/** Routed (non-borrowed) codex repairs that ended unproductive this many times in a row on one head fall back to Claude. */
export const ROUTED_CODEX_MAX_UNPRODUCTIVE = 2;
/** One file PER PR, so concurrent fix-runs for different PRs never read-modify-write the same file; writes are atomic
 *  (temp + rename). Fix and ci-heal claims are per kind, so a concurrent fix + ci-heal on ONE PR can still lose at most
 *  one entry, which only delays the Claude fallback by one run. Content keeps the `{ "<repo>#<pr>": [...] }` shape. */
export const routedOutcomePath = ({ repo = 'we', pr }) =>
  join(resolveCoordinationRoot(), 'fix-routed-outcomes', `${String(repo).replace(/[^A-Za-z0-9._-]/g, '_')}_${String(pr).replace(/[^0-9]/g, '')}.json`);
export const readRoutedOutcomes = ({ repo = 'we', pr } = {}) => fileLedger(routedOutcomePath({ repo, pr })).read();

/** Sentinel merge target: fix-run resolves it to the PR's live `baseRefName` from `gh pr view` (never guesses `main`). */
export const PR_BASE_MERGE_TARGET = '@pr-base';
/** The ref a launcher-started merge targets: the restack base, else the PR base for a conflict, else (base unknown)
 *  {@link PR_BASE_MERGE_TARGET} so fix-run reads it — a guessed `main` could merge main into a stacked PR. null = no merge. */
export const mergeOntoFor = (planned) => planned.restack?.onto ?? (planned.isConflict ? planned.baseRefName || PR_BASE_MERGE_TARGET : null);

export function consecutiveUnproductiveOnHead(table, { repo = 'we', pr, head }) {
  if (!head) return 0;
  let count = 0;
  for (const entry of [...(table?.[`${repo}#${pr}`] ?? [])].reverse()) {
    if (entry.head !== head || entry.outcome === 'pushed') break;
    count++;
  }
  return count;
}

const oneLine = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);

/** `reason` is the local diagnosis (may hold command errors); `note` is the agent's final message, the only text a PR comment shows. */
export function recordRoutedOutcome({ repo = 'we', pr, head, outcome, reason = '', note = '', now = Date.now(), store = fileLedger(routedOutcomePath({ repo, pr })),
  readClaim = (kind) => readLockEntry(fixDispatchClaimRoot(), fixDispatchResource({ repo, pr, kind })),
}) {
  // Borrowed launches keep their existing ledger and retry policy.
  if (['fix', 'ci-heal'].some(kind => readClaim(kind)?.meta?.borrowed)) return {};
  const table = store.read() ?? {};
  const key = `${repo}#${pr}`;
  if (outcome === 'pushed') delete table[key];
  else table[key] = [...(table[key] ?? []), { at: now, head, outcome, reason: oneLine(reason), note: oneLine(note) }].slice(-10);
  store.write(table);
  return table;
}

export const defaultBorrowOutcomePath = () => join(resolveCoordinationRoot(), 'fix-borrow-outcomes.json');

/** Durable per-PR record of how borrowed launches ended: `{ "<repo>#<pr>": [{at, outcome, reason}] }`. */
export function fileOutcomeStore(path = defaultBorrowOutcomePath()) {
  return fileLedger(path);
}

/** Record one borrowed launch's end. `pushed` clears the PR's history; anything else is appended (last 10 kept). */
export function recordBorrowOutcome({ repo, pr, outcome, reason = '', now = Date.now(), store = fileOutcomeStore() }) {
  // fix-run also serves ordinary routed repairs; those must not mutate borrow outcomes.
  for (const kind of ['fix', 'ci-heal']) {
    const claim = readLockEntry(fixDispatchClaimRoot(), fixDispatchResource({ repo, pr, kind }));
    if (claim?.meta?.fixExecutor && !claim.meta.borrowed) return;
  }
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
    write(v) {
      // temp + rename: a reader never sees a half-written file.
      const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 }); renameSync(tmp, path); }
      catch { try { rmSync(tmp, { force: true }); } catch { /* best-effort */ } /* best-effort: a lost ledger only restarts the wait */ }
    },
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
  loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length, alive = isPidAlive, sample,
  hostGate, // x6nuodj: null → gateLaunch (admit({kind:'fix'}) decides; legacy gateHost is the logged comparison)
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
      try { gate = (hostGate ?? (() => gateLaunch({ kind: 'fix', gate: 'fix-slot-borrow', env, loadavg, cpuCount, ...(sample ? { sample } : {}) })))(); } catch { /* fail open, like every load read */ }
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
