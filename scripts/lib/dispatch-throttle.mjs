/**
 * @file scripts/lib/dispatch-throttle.mjs
 * @description Declared dispatch-throttle settings + the two DEFER-ONLY launch gates (live incident 2026-10-06:
 *   4 fixers + a build + agent builds drove host load to ~36 on 12 cores). Both gates only refuse NEW launches
 *   with a logged reason; they never interrupt running work and never weaken a safety check.
 *
 * SETTINGS live in `we:scripts/dispatch-settings.json` (declared), each overridable by an env var (a launchd
 *   plist `EnvironmentVariables` entry):
 *   - heavyAdmissionCap          (env WE_HEAVY_ADMISSION_CAP)            default 2 — heavy-command slots. The
 *     per-daemon plist override lives in ~/Library/LaunchAgents/com.we.<daemon>.plist (templates:
 *     we:skills-src/conveyor/launchd/*.plist.example); remove it to follow this file.
 *   - fixDispatchMaxConcurrent   (env WE_FIX_DISPATCH_MAX_CONCURRENT)    default 2 — live fix-* + ci-heal-* sessions.
 *   - maxLoadPerCore             (env WE_MAX_LOAD_PER_CORE)              default 2.0 — 1-min loadavg / cores.
 *   - fixDispatch.borrowBuildSlots (env WE_FIX_BORROW_BUILD_SLOTS)       default OFF (product); `on`/`off`. When ON, a
 *     fix held ONLY by the fixer cap may borrow a FREE builder slot (card 87; see `fix-slot-borrow.mjs`).
 *   - fixDispatch.borrowAfterMinutes (env WE_FIX_BORROW_AFTER_MINUTES)   default 15 — how long the fix must have waited.
 *   - fixDispatch.borrowExecutor (env WE_FIX_BORROW_EXECUTOR)            default codex; `codex` | `claude` | `agy-claude`.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DISPATCH_SETTINGS_BUILT_IN = Object.freeze({ heavyAdmissionCap: 2, fixDispatchMaxConcurrent: 2, maxLoadPerCore: 2.0 });
export const DISPATCH_SETTINGS_ENV = Object.freeze({
  heavyAdmissionCap: 'WE_HEAVY_ADMISSION_CAP',
  fixDispatchMaxConcurrent: 'WE_FIX_DISPATCH_MAX_CONCURRENT',
  maxLoadPerCore: 'WE_MAX_LOAD_PER_CORE',
});
const INTEGER_KEYS = new Set(['heavyAdmissionCap', 'fixDispatchMaxConcurrent']);

export const FIX_BORROW_BUILT_IN = Object.freeze({ borrowBuildSlots: 'off', borrowAfterMinutes: 15, borrowExecutor: 'codex' });
export const FIX_BORROW_EXECUTORS = Object.freeze(['codex', 'claude', 'agy-claude']);
const FIX_BORROW_ENV = Object.freeze({
  borrowBuildSlots: 'WE_FIX_BORROW_BUILD_SLOTS', borrowAfterMinutes: 'WE_FIX_BORROW_AFTER_MINUTES', borrowExecutor: 'WE_FIX_BORROW_EXECUTOR',
});

export function defaultDispatchSettingsPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../dispatch-settings.json');
}

const valid = (key, n) => Number.isFinite(n) && (INTEGER_KEYS.has(key) ? n >= 1 : n > 0);
const norm = (key, n) => (INTEGER_KEYS.has(key) ? Math.floor(n) : n);

/** Resolve one setting: valid env wins, then a valid file value, then the built-in. Never throws. */
export function resolveDispatchSetting(key, { env = process.env, file } = {}) {
  const fromEnv = env?.[DISPATCH_SETTINGS_ENV[key]];
  if (fromEnv !== undefined && fromEnv !== '' && valid(key, Number(fromEnv))) return norm(key, Number(fromEnv));
  let raw = file;
  if (raw === undefined) {
    try { raw = JSON.parse(readFileSync(defaultDispatchSettingsPath(), 'utf8')); } catch { raw = null; }
  }
  const v = raw && typeof raw === 'object' ? raw[key] : undefined;
  if (typeof v === 'number' && valid(key, v)) return norm(key, v);
  return DISPATCH_SETTINGS_BUILT_IN[key];
}

export const resolveFixDispatchMaxConcurrent = (o) => resolveDispatchSetting('fixDispatchMaxConcurrent', o);
export const resolveMaxLoadPerCore = (o) => resolveDispatchSetting('maxLoadPerCore', o);
export const resolveHeavyAdmissionCap = (o) => resolveDispatchSetting('heavyAdmissionCap', o);

/**
 * How many ci-heal sessions may run PAST the fixer cap (env WE_CI_HEAL_RESERVE, default 1, 0 = none). A PR that failed
 * its OWN required check is owed a ci-heal owner; review fixes that fill the cap must not starve it forever (live
 * incident 2026-10-07: #4235 sat red for hours, logged `refused fix-cap ... ci-heal deferred` every pass).
 */
export function resolveCiHealReserve({ env = process.env } = {}) {
  const e = env?.WE_CI_HEAL_RESERVE;
  const n = Number(e);
  return e !== undefined && e !== '' && Number.isInteger(n) && n >= 0 ? n : 1;
}

/** Pure: is the host too loaded to START new work? Unreadable load/cores fails OPEN (admit). */
export function hostLoadGate({ load, cores, maxLoadPerCore = DISPATCH_SETTINGS_BUILT_IN.maxLoadPerCore } = {}) {
  if (!Number.isFinite(load) || !Number.isFinite(cores) || cores < 1) return { admit: true };
  const perCore = load / cores;
  if (perCore <= maxLoadPerCore) return { admit: true, perCore };
  return {
    admit: false, kind: 'host-load', perCore,
    why: `host load ${load.toFixed(1)} on ${cores} cores = ${perCore.toFixed(2)}/core > ${maxLoadPerCore}/core (WE_MAX_LOAD_PER_CORE); launch deferred, running work untouched`,
  };
}

/** Count live fix/ci-heal claims (the dispatcher's own heartbeat-refreshed liveness; `fixing` is not a session). */
export function countLiveFixSessions(claims = []) {
  return claims.filter((c) => c?.meta?.kind === 'fix' || c?.meta?.kind === 'ci-heal').length;
}

/**
 * ONE throttle per daemon pass, shared by fix and ci-heal dispatch. `tryAdmit(kind)` returns
 * `{admit:true}` (and counts the launch) or `{admit:false, kind:'fix-cap'|'host-load', why}`.
 */
export function createDispatchThrottle({
  listClaims = () => [], env = process.env, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length,
} = {}) {
  let live = null;
  let liveHeal = 0;
  return {
    tryAdmit(kind = 'fix') {
      const cap = resolveFixDispatchMaxConcurrent({ env });
      if (live === null) {
        try { const claims = listClaims(); live = countLiveFixSessions(claims); liveHeal = claims.filter((c) => c?.meta?.kind === 'ci-heal').length; } catch { live = 0; liveHeal = 0; }
      }
      const reserve = resolveCiHealReserve({ env });
      // A ci-heal may take the reserved slot past the cap; a fix never can.
      const reserved = kind === 'ci-heal' && live >= cap && liveHeal < reserve;
      if (live >= cap && !reserved) {
        const note = kind === 'ci-heal' ? `; the ${reserve} reserved ci-heal slot(s) (WE_CI_HEAL_RESERVE) are in use` : '';
        return { admit: false, kind: 'fix-cap', why: `${live} live fix/ci-heal session(s) >= cap ${cap} (WE_FIX_DISPATCH_MAX_CONCURRENT)${note}; ${kind} deferred, no claim taken` };
      }
      let gate = { admit: true };
      try { gate = hostLoadGate({ load: loadavg(), cores: cpuCount(), maxLoadPerCore: resolveMaxLoadPerCore({ env }) }); } catch { /* fail open */ }
      if (!gate.admit) return gate;
      live += 1;
      if (kind === 'ci-heal') liveHeal += 1;
      return { admit: true };
    },
  };
}

/**
 * Card 87 — the borrow-a-builder-slot settings (`fixDispatch` block). Env wins, then a valid file value, then the
 * built-in (product default OFF). Never throws; an invalid value falls to the next source, never to ON.
 * @returns {{enabled:boolean, afterMinutes:number, executor:'codex'|'claude'|'agy-claude'}}
 */
export function resolveFixBorrowSettings({ env = process.env, file } = {}) {
  let raw = file;
  if (raw === undefined) {
    try { raw = JSON.parse(readFileSync(defaultDispatchSettingsPath(), 'utf8')); } catch { raw = null; }
  }
  const block = raw && typeof raw === 'object' && raw.fixDispatch && typeof raw.fixDispatch === 'object' ? raw.fixDispatch : {};
  const pick = (key, ok) => {
    const e = env?.[FIX_BORROW_ENV[key]];
    if (e !== undefined && e !== '' && ok(e)) return e;
    const v = block[key];
    if (v !== undefined && ok(v)) return v;
    return FIX_BORROW_BUILT_IN[key];
  };
  const onOff = (v) => ['on', 'off'].includes(String(v).trim().toLowerCase());
  const minutes = (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && String(v).trim() !== '';
  const executor = (v) => FIX_BORROW_EXECUTORS.includes(String(v).trim().toLowerCase());
  return {
    enabled: String(pick('borrowBuildSlots', onOff)).trim().toLowerCase() === 'on',
    afterMinutes: Number(pick('borrowAfterMinutes', minutes)),
    executor: String(pick('borrowExecutor', executor)).trim().toLowerCase(),
  };
}
