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
  return {
    tryAdmit(kind = 'fix') {
      const cap = resolveFixDispatchMaxConcurrent({ env });
      if (live === null) { try { live = countLiveFixSessions(listClaims()); } catch { live = 0; } }
      if (live >= cap) {
        return { admit: false, kind: 'fix-cap', why: `${live} live fix/ci-heal session(s) >= cap ${cap} (WE_FIX_DISPATCH_MAX_CONCURRENT); ${kind} deferred, no claim taken` };
      }
      let gate = { admit: true };
      try { gate = hostLoadGate({ load: loadavg(), cores: cpuCount(), maxLoadPerCore: resolveMaxLoadPerCore({ env }) }); } catch { /* fail open */ }
      if (!gate.admit) return gate;
      live += 1;
      return { admit: true };
    },
  };
}
