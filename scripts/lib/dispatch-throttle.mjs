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
 *   - maxLoadPerCore             (env WE_MAX_LOAD_PER_CORE)              default 2.0 — 1-min loadavg / cores. FALLBACK
 *     only, used when the CPU sample fails (macOS load average overstates saturation).
 *   - cpuIdleMinPct.<kind>       (env WE_MIN_CPU_IDLE_PCT_<KIND>)        PRIMARY signal: hold a launch when real CPU idle %
 *     is below it. Defaults fix 8, ci-heal 8, build 15, prepare 20, review 10 (KIND upper-case, `-` -> `_`).
 *   - memFreeMinPct              (env WE_MIN_MEM_FREE_PCT)               default 15 — hold when free memory % is below it.
 *   - fixDispatch.borrowBuildSlots (env WE_FIX_BORROW_BUILD_SLOTS)       default OFF (product); `on`/`off`. When ON, a
 *     fix held ONLY by the fixer cap may borrow a FREE builder slot (card 87; see `fix-slot-borrow.mjs`).
 *   - fixDispatch.borrowAfterMinutes (env WE_FIX_BORROW_AFTER_MINUTES)   default 15 — how long the fix must have waited.
 *   - fixDispatch.borrowExecutor (env WE_FIX_BORROW_EXECUTOR)            default codex; `codex` | `claude` | `agy-claude`.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleHost } from './host-sample.mjs';

export const CPU_IDLE_MIN_BUILT_IN = Object.freeze({ fix: 8, 'ci-heal': 8, build: 15, prepare: 20, review: 10 });
export const DISPATCH_SETTINGS_BUILT_IN = Object.freeze({ heavyAdmissionCap: 2, fixDispatchMaxConcurrent: 2, maxLoadPerCore: 2.0, memFreeMinPct: 15 });
export const DISPATCH_SETTINGS_ENV = Object.freeze({
  heavyAdmissionCap: 'WE_HEAVY_ADMISSION_CAP',
  fixDispatchMaxConcurrent: 'WE_FIX_DISPATCH_MAX_CONCURRENT',
  maxLoadPerCore: 'WE_MAX_LOAD_PER_CORE',
  memFreeMinPct: 'WE_MIN_MEM_FREE_PCT',
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
export const resolveMemFreeMinPct = (o) => resolveDispatchSetting('memFreeMinPct', o);

/** Minimum CPU idle % for a launch of `kind`: valid env wins, then the file's `cpuIdleMinPct.<kind>`, then built-in.
 *  An unknown kind uses the `fix` threshold. Never throws. */
export function resolveCpuIdleMinPct(kind = 'fix', { env = process.env, file } = {}) {
  const k = Object.hasOwn(CPU_IDLE_MIN_BUILT_IN, kind) ? kind : 'fix';
  const ok = (n) => Number.isFinite(n) && n >= 0 && n <= 100;
  const e = env?.[`WE_MIN_CPU_IDLE_PCT_${k.toUpperCase().replace(/-/g, '_')}`];
  if (e !== undefined && e !== '' && ok(Number(e))) return Number(e);
  let raw = file;
  if (raw === undefined) { try { raw = JSON.parse(readFileSync(defaultDispatchSettingsPath(), 'utf8')); } catch { raw = null; } }
  const v = raw?.cpuIdleMinPct?.[k];
  return typeof v === 'number' && ok(v) ? v : CPU_IDLE_MIN_BUILT_IN[k];
}

/**
 * Pure: is the host too busy to START `kind` work? PRIMARY signal is real CPU idle % (`cpuIdlePct`, held below
 * `minIdlePct`), second is free memory % (held below `minMemFreePct`). Load average is only the FALLBACK when
 * `cpuIdlePct` is unreadable. Every result names `signal` (`cpu-idle` | `mem-free` | `load-avg`) so logs show what
 * decided. Unreadable everything fails OPEN (admit).
 */
export function hostLoadGate({
  kind = 'fix', load, cores, maxLoadPerCore = DISPATCH_SETTINGS_BUILT_IN.maxLoadPerCore,
  cpuIdlePct, memFreePct, minIdlePct = CPU_IDLE_MIN_BUILT_IN[kind] ?? CPU_IDLE_MIN_BUILT_IN.fix,
  minMemFreePct = DISPATCH_SETTINGS_BUILT_IN.memFreeMinPct,
} = {}) {
  if (Number.isFinite(cpuIdlePct)) {
    if (cpuIdlePct < minIdlePct) {
      return { admit: false, kind: 'host-load', signal: 'cpu-idle', cpuIdlePct,
        why: `cpu-idle signal: ${cpuIdlePct.toFixed(1)}% idle < ${minIdlePct}% needed for ${kind} (WE_MIN_CPU_IDLE_PCT_${String(kind).toUpperCase().replace(/-/g, '_')}); launch deferred, running work untouched` };
    }
    if (Number.isFinite(memFreePct) && memFreePct < minMemFreePct) {
      return { admit: false, kind: 'host-load', signal: 'mem-free', cpuIdlePct, memFreePct,
        why: `mem-free signal: ${memFreePct}% memory free < ${minMemFreePct}% (WE_MIN_MEM_FREE_PCT); ${kind} launch deferred, running work untouched` };
    }
    return { admit: true, signal: 'cpu-idle', cpuIdlePct, memFreePct: Number.isFinite(memFreePct) ? memFreePct : undefined,
      note: `cpu-idle signal: ${cpuIdlePct.toFixed(1)}% idle >= ${minIdlePct}% for ${kind}` };
  }
  if (!Number.isFinite(load) || !Number.isFinite(cores) || cores < 1) return { admit: true };
  const perCore = load / cores;
  if (perCore <= maxLoadPerCore) return { admit: true, signal: 'load-avg', perCore };
  return {
    admit: false, kind: 'host-load', signal: 'load-avg', perCore,
    why: `load-avg signal (cpu sample unavailable, fallback): host load ${load.toFixed(1)} on ${cores} cores = ${perCore.toFixed(2)}/core > ${maxLoadPerCore}/core (WE_MAX_LOAD_PER_CORE); launch deferred, running work untouched`,
  };
}

/** Resolve every knob, take the cached host sample, and decide. `sample` is injectable (`() => {ok, idlePct, memFreePct}`).
 *  Never throws: a failed sample falls back to load average. */
export function gateHost({
  kind = 'fix', env = process.env, sample = () => sampleHost(), loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length,
} = {}) {
  let s = null;
  try { s = sample(); } catch { s = null; }
  const usable = s?.ok && Number.isFinite(s.idlePct);
  let load; let cores;
  if (!usable) { try { load = loadavg(); cores = cpuCount(); } catch { /* fail open */ } }
  return hostLoadGate({
    kind, load, cores, maxLoadPerCore: resolveMaxLoadPerCore({ env }),
    cpuIdlePct: usable ? s.idlePct : undefined, memFreePct: usable ? s.memFreePct ?? undefined : undefined,
    minIdlePct: resolveCpuIdleMinPct(kind, { env }), minMemFreePct: resolveMemFreeMinPct({ env }),
  });
}

/** Is `pid` a running process? EPERM means it exists (owned by someone else); ESRCH / bad input means it does not. */
export function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

/** A BORROWED fix claim whose runner process (`meta.runnerPid`, stamped at launch) is gone. A claim with no runner pid
 *  yet (just taken, not stamped) is NOT dead: only the plain TTL can end it. Pure given `alive`. */
export function isBorrowedRunnerDead(claim, alive = isPidAlive) {
  const pid = claim?.meta?.runnerPid;
  return Boolean(claim?.meta?.borrowed) && Number.isInteger(pid) && pid > 0 && !alive(pid);
}

/** Count LIVE fix/ci-heal claims (`fixing` is not a session). A borrowed claim whose runner pid is dead is not live:
 *  it must not hold a cap slot while it waits out its TTL. */
export function countLiveFixSessions(claims = [], { alive = isPidAlive } = {}) {
  return claims.filter((c) => (c?.meta?.kind === 'fix' || c?.meta?.kind === 'ci-heal') && !isBorrowedRunnerDead(c, alive)).length;
}

/**
 * ONE throttle per daemon pass, shared by fix and ci-heal dispatch. `tryAdmit(kind)` returns
 * `{admit:true}` (and counts the launch) or `{admit:false, kind:'fix-cap'|'host-load', why}`.
 */
export function createDispatchThrottle({
  listClaims = () => [], env = process.env, loadavg = () => os.loadavg()[0], cpuCount = () => os.cpus().length,
  alive = isPidAlive, sample = () => sampleHost(),
} = {}) {
  let live = null;
  return {
    tryAdmit(kind = 'fix') {
      const cap = resolveFixDispatchMaxConcurrent({ env });
      if (live === null) { try { live = countLiveFixSessions(listClaims(), { alive }); } catch { live = 0; } }
      if (live >= cap) {
        return { admit: false, kind: 'fix-cap', why: `${live} live fix/ci-heal session(s) >= cap ${cap} (WE_FIX_DISPATCH_MAX_CONCURRENT); ${kind} deferred, no claim taken` };
      }
      let gate = { admit: true };
      try { gate = gateHost({ kind, env, sample, loadavg, cpuCount }); } catch { /* fail open */ }
      if (!gate.admit) return gate;
      live += 1;
      return { admit: true, ...(gate.note ? { note: gate.note, signal: gate.signal } : {}) };
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
