/**
 * @file scripts/lib/daemon-background-build.mjs
 * @description x44lnnt — build the daemon's next version OFF the tick path (ruled event-daemon design E5: "a
 *   separate builder process", "restart only between handlers").
 *
 * LIVE BUG (2026-10-09 05:53Z→07:11Z): `withSelfSync`'s default path awaited `rebuildClone` at the START of every
 * tick. The rebuild's live smoke took 10–24 min on a loaded host, and an adopted rebuild restarted the daemon
 * INSTEAD of ticking. While `main` moved faster than the smoke, the fix daemon never completed a tick for 68 min:
 * no fix / ci-heal dispatches, green drafts left unpromoted.
 *
 * THE FIX, smallest safe version (all behind declared settings; a daemon not listed in `enabled` runs exactly as
 * before):
 *   1. A detached BUILDER process (`we:scripts/lib/daemon-rebuild-builder.mjs`) runs the same gated
 *      `rebuildClone` — same lease, same unlocked candidate smoke, same locked finalize, same guards — while the
 *      daemon keeps ticking on its current, already-smoked code. The builder is started only BETWEEN ticks (after a
 *      tick released its read lock), so its short locked prepare never races a tick it started itself.
 *   2. The SWAP stays the existing "HEAD moved since boot" restart, taken at the start of a tick (never mid-tick),
 *      and at most once per `swapMinIntervalMs`.
 *   3. COALESCE: at most one builder start per `buildMinIntervalMs`, and none while a swap is already pending
 *      (the new process builds after its own first tick) — a fast-moving `main` never restarts the smoke from
 *      scratch more often than the setting allows.
 *   4. SMELL `tick-starved`: no completed tick for `tickStarvedSmellMs` while rebuilds keep adopting. Evaluated
 *      for EVERY daemon (on or off), because the off path is exactly where it happens. Logged + appended to the
 *      clone's `alerts.jsonl` (surfaced by daemon-status).
 *
 * Pure rules ({@link decideBuilderStart}, {@link tickStarvedSmell}, {@link resolveBackgroundBuild}) are separate
 * from the IO shells below and replay-tested against tonight's log (fixtures/background-build/).
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneKey } from './daemon-overlays.mjs';
import { daemonStateDir } from './daemon-last-good.mjs';
import { cascadePolicy } from './policy-cascade.mjs';

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────

/** Built-in defaults: OFF for every daemon (an empty `enabled` map) — exactly today's behavior. */
export const BUILT_IN_BACKGROUND_BUILD_SETTINGS = Object.freeze({
  enabled: Object.freeze({}),
  swapMinIntervalMs: 10 * 60_000,
  buildMinIntervalMs: 5 * 60_000,
  tickStarvedSmellMs: 30 * 60_000,
  // An unfinished builder record older than this is dead whatever its pid says (a SIGKILL / OOM / reboot leaves
  // `finishedAt: null` behind and the pid is later reused). The smoke takes 10–24 min; this is ~4× the worst seen.
  builderMaxAgeMs: 90 * 60_000,
});

/** Env: `1`/`true` forces background builds ON for this process, `0`/`false` forces OFF; unset → the file. */
export const BACKGROUND_BUILD_ENV = 'WE_DAEMON_BACKGROUND_BUILD';
const NUMBER_ENV = {
  swapMinIntervalMs: 'WE_DAEMON_BACKGROUND_BUILD_SWAP_MIN_INTERVAL_MS',
  buildMinIntervalMs: 'WE_DAEMON_BACKGROUND_BUILD_MIN_INTERVAL_MS',
  tickStarvedSmellMs: 'WE_DAEMON_TICK_STARVED_SMELL_MS',
  builderMaxAgeMs: 'WE_DAEMON_BACKGROUND_BUILD_MAX_AGE_MS',
};

export function defaultBackgroundBuildSettingsPath() {
  return join(dirname(fileURLToPath(import.meta.url)), 'daemon-background-build-settings.json');
}

const nonneg = (v) => Number.isSafeInteger(v) && v >= 0;

/** PURE: validate a parsed settings object key by key; anything malformed keeps the built-in default. */
export function validateBackgroundBuildSettings(raw) {
  const out = { ...BUILT_IN_BACKGROUND_BUILD_SETTINGS };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  if (raw.enabled && typeof raw.enabled === 'object' && !Array.isArray(raw.enabled)
    && Object.entries(raw.enabled).every(([k, v]) => typeof k === 'string' && k && !k.includes('/') && typeof v === 'boolean')) {
    out.enabled = { ...raw.enabled };
  }
  for (const k of Object.keys(NUMBER_ENV)) if (nonneg(raw[k])) out[k] = raw[k];
  return out;
}

/** The file is the tool layer over the team's platform preference `daemonBackgroundBuild` (shared policy cascade,
 *  we:scripts/lib/policy-cascade.mjs): a key the file leaves unset takes the platform value. */
export function loadBackgroundBuildSettings(path = defaultBackgroundBuildSettingsPath(), { env = process.env } = {}) {
  let tool;
  try { tool = JSON.parse(readFileSync(path, 'utf8')); } catch { tool = undefined; }
  const c = cascadePolicy('daemonBackgroundBuild', tool, { env, standard: BUILT_IN_BACKGROUND_BUILD_SETTINGS });
  return validateBackgroundBuildSettings(c.layered ?? null);
}

/**
 * PURE: the effective background-build config for one daemon entry (its script basename, e.g.
 * `reconcile-fix-dispatch-daemon.mjs`). Env beats file; a malformed env value keeps the file value.
 * @returns {{enabled:boolean, swapMinIntervalMs:number, buildMinIntervalMs:number, tickStarvedSmellMs:number, builderMaxAgeMs:number, source:string}}
 */
export function resolveBackgroundBuild({ entry, settings = BUILT_IN_BACKGROUND_BUILD_SETTINGS, env = {} } = {}) {
  const s = validateBackgroundBuildSettings(settings);
  const name = entry ? basename(String(entry)) : '';
  let enabled = !!(name && s.enabled[name] === true);
  let source = enabled ? 'file' : 'default';
  const flag = env?.[BACKGROUND_BUILD_ENV];
  if (flag === '1' || flag === 'true') { enabled = true; source = 'env'; }
  else if (flag === '0' || flag === 'false') { enabled = false; source = 'env'; }
  const out = { enabled, source };
  for (const [k, envKey] of Object.entries(NUMBER_ENV)) {
    const raw = env?.[envKey];
    const n = raw === undefined || raw === '' ? NaN : Number(raw);
    out[k] = nonneg(n) ? n : s[k];
  }
  return out;
}

// ── pure rules ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * PURE: may the daemon start a builder now (called only between ticks)?
 * @param {{enabled:boolean, builderAlive:boolean, lastStartedAtMs:number|null, swapPending:boolean,
 *   nowMs:number, buildMinIntervalMs:number}} o
 * @returns {{start:boolean, reason:string}}
 */
export function decideBuilderStart({ enabled, builderAlive, lastStartedAtMs, swapPending, nowMs, buildMinIntervalMs }) {
  if (!enabled) return { start: false, reason: 'off' };
  if (builderAlive) return { start: false, reason: 'builder-running' };
  // A built version is already waiting for the swap: the next process builds after its own first tick.
  if (swapPending) return { start: false, reason: 'swap-pending' };
  if (Number.isFinite(lastStartedAtMs) && nowMs - lastStartedAtMs < buildMinIntervalMs) return { start: false, reason: 'coalesce' };
  return { start: true, reason: 'due' };
}

/**
 * PURE: the `tick-starved` smell. Starved when no tick has completed for `thresholdMs` (measured from the last
 * completed tick, else from when the daemon was first seen) AND a rebuild has adopted since then — rebuilds
 * succeed but the work they gate never runs. Without an adoption since, it is some other stall (not this smell).
 * @param {{lastTickDoneAtMs:number|null, firstSeenAtMs:number|null, lastAdoptedAtMs:number|null, nowMs:number, thresholdMs:number}} o
 * @returns {{starved:boolean, reason:string, sinceTickMs?:number}}
 */
export function tickStarvedSmell({ lastTickDoneAtMs, firstSeenAtMs, lastAdoptedAtMs, nowMs, thresholdMs }) {
  if (!(thresholdMs > 0)) return { starved: false, reason: 'off' };
  const ref = Number.isFinite(lastTickDoneAtMs) ? lastTickDoneAtMs : firstSeenAtMs;
  if (!Number.isFinite(ref)) return { starved: false, reason: 'no-baseline' };
  const sinceTickMs = Math.max(0, nowMs - ref);
  if (sinceTickMs < thresholdMs) return { starved: false, reason: 'ticking', sinceTickMs };
  if (!Number.isFinite(lastAdoptedAtMs) || lastAdoptedAtMs < ref) return { starved: false, reason: 'no-adoption-since', sinceTickMs };
  return { starved: true, reason: 'rebuilds-adopt-but-no-tick', sinceTickMs };
}

// ── IO: builder state + spawn ────────────────────────────────────────────────────────────────────────────

export function builderStatePath(root, env = process.env) {
  return join(daemonStateDir(env), `${cloneKey(root)}.builder.json`);
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Never throws: a missing/corrupt file reads as null. */
export function readBuilderState(root, env = process.env) {
  try { return JSON.parse(readFileSync(builderStatePath(root, env), 'utf8')); } catch { return null; }
}

export function writeBuilderState(root, state, env = process.env) {
  writeJsonAtomic(builderStatePath(root, env), state);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

/**
 * Is the recorded builder still running? Unfinished + same host + younger than `maxAgeMs` + live pid. Another host:
 * never ours to wait on. The age bound is what stops a stale record (a SIGKILL / OOM / reboot left `finishedAt: null`)
 * whose pid was later reused — by any unrelated process, or one that `kill(pid, 0)` merely reports EPERM for — from
 * counting as a live builder forever and starving every later build. A record whose age cannot be read cannot be
 * bounded, so it is not trusted either (the spawner always writes `startedAt`).
 */
export function builderIsAlive(state, {
  isAlive = pidAlive, host = hostname(), nowMs = Date.now(), maxAgeMs = BUILT_IN_BACKGROUND_BUILD_SETTINGS.builderMaxAgeMs,
} = {}) {
  if (!state || state.finishedAt) return false;
  if (state.host && state.host !== host) return false;
  const startedMs = Date.parse(state.startedAt || '');
  // Older than the bound — or dated in the future beyond clock skew (a clock jump back would otherwise keep a stale
  // record "young" indefinitely).
  if (!Number.isFinite(startedMs) || nowMs - startedMs > maxAgeMs || startedMs - nowMs > CLOCK_SKEW_MS) return false;
  return !!isAlive(state.pid);
}

const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Did a builder RUN finish (any verdict)? A spawn that never started is recorded finished too (so nothing waits on
 * it), and a builder that hit its deadline is recorded finished so a successor can start — but no rebuild completed
 * in either case: neither may count as "the builder's run on the fresh clone has finished".
 */
export function builderRunFinished(state) {
  return !!state?.finishedAt && !/^(spawn-failed|builder-deadline)/.test(String(state?.result?.reason ?? ''));
}

/** The builder CLI, resolved next to THIS module (the daemon clone's own tree). */
export const BUILDER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'daemon-rebuild-builder.mjs');

/**
 * The checkout's identity (`dev:ino` of the clone directory), or null when it cannot be read. A re-clone renames the
 * old directory aside and clones into the vacated path, so the identity changes exactly when the checkout was
 * replaced — and a replacement needs the clone's WRITE lock, so under a READ lock the value is stable.
 */
export function readCloneIdentity(root) {
  try { const s = statSync(root); return `${s.dev}:${s.ino}`; } catch { return null; }
}

/** When the current checkout directory was created (ms), or null where the filesystem does not report it. */
export function readCloneBornAtMs(root) {
  try { const b = statSync(root).birthtimeMs; return b > 0 ? b : null; } catch { return null; }
}

/**
 * Spawn the detached builder. It inherits stdout/stderr (the daemon's launchd log), so its `daemon-rebuild:` lines
 * land in the same log as before; it is in its own process group, so a daemon restart (the swap) never kills a
 * smoke in flight. Records `{pid, host, startedAt}` before returning.
 *
 * Two things carry over / are handled here, both found in review:
 *  - `recloned` is carried forward from the previous record. The builder that re-cloned the checkout may die or
 *    finish still flagged; the NEXT builder's record must keep the fail-closed marker until that builder's own run
 *    on the fresh clone has finished (the builder clears it itself, in `daemon-rebuild-builder.mjs`).
 *  - `spawn` reports ENOENT / EAGAIN / EMFILE as an ASYNC 'error' event, not a throw — with no listener that is an
 *    uncaught exception that kills the daemon. The listener logs it and records the build as finished + failed, so
 *    nothing waits on a builder that never existed; the next tick retries once the coalesce window allows.
 */
export function spawnBuilder({ root, entries = [], env = process.env, mainOnly = false, spawnFn = spawn, nowMs = Date.now(), log = console, maxAgeMs }) {
  const args = [
    BUILDER_SCRIPT, `--root=${root}`, ...entries.filter(Boolean).map((e) => `--entry=${e}`), ...(mainOnly ? ['--main-only'] : []),
    // The builder's own deadline = the age after which the daemon stops trusting its record: it must not outlive it.
    ...(maxAgeMs > 0 ? [`--max-age-ms=${maxAgeMs}`] : []),
  ];
  const prev = readBuilderState(root, env);
  const child = spawnFn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  child.on?.('error', (err) => {
    try {
      const why = String((err && err.message) || err).split('\n')[0];
      log.error?.(`daemon-self-sync: the background build could not start (${why}) — ticking on, the next tick retries (x44lnnt)`);
      const cur = readBuilderState(root, env);
      // Only mark our own record: a later spawn may already have replaced it.
      if (cur && cur.startedAt === state.startedAt && !cur.finishedAt) {
        writeBuilderState(root, { ...cur, finishedAt: new Date().toISOString(), result: { moved: false, adopted: false, reason: `spawn-failed: ${why}` } }, env);
      }
    } catch { /* a failed spawn report never breaks the daemon */ }
  });
  child.unref?.();
  const state = {
    pid: child.pid, host: hostname(), startedAt: new Date(nowMs).toISOString(), finishedAt: null, result: null, by: process.pid,
    ...(prev?.recloned ? { recloned: true } : {}),
  };
  writeBuilderState(root, state, env);
  return state;
}

/** The builder API `withSelfSync` uses (injectable in tests). */
export function makeBuilderApi({ root, entries, env = process.env, mainOnly = false, log = console, maxAgeMs }) {
  return {
    read: () => readBuilderState(root, env),
    alive: (state) => builderIsAlive(state, maxAgeMs > 0 ? { maxAgeMs } : {}),
    start: ({ nowMs } = {}) => spawnBuilder({ root, entries, env, mainOnly, log, maxAgeMs, ...(nowMs ? { nowMs } : {}) }),
  };
}

// ── IO: tick progress (feeds the smell; survives restarts) ───────────────────────────────────────────────

export function tickProgressPath(root, entry, env = process.env) {
  const name = basename(String(entry || 'daemon')).replace(/[^A-Za-z0-9._-]/g, '_');
  return join(daemonStateDir(env), `${cloneKey(root)}.ticks.${name}.json`);
}

/** A tiny persisted record `{firstSeenAt, lastTickDoneAt}` per clone + daemon entry. Every method never throws. */
export function makeTickProgressStore({ root, entry, env = process.env }) {
  const path = tickProgressPath(root, entry, env);
  const read = () => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
  const write = (v) => { try { writeJsonAtomic(path, v); } catch { /* a smell never breaks a tick */ } };
  return {
    read,
    markSeen: (nowMs) => { const cur = read(); if (!cur?.firstSeenAt) write({ ...(cur || {}), firstSeenAt: new Date(nowMs).toISOString() }); },
    markTickDone: (nowMs) => write({ ...(read() || {}), lastTickDoneAt: new Date(nowMs).toISOString(), pid: process.pid }),
    alert: (kind, detail, nowMs) => {
      try {
        const file = join(daemonStateDir(env), `${cloneKey(root)}.alerts.jsonl`);
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify({ at: new Date(nowMs).toISOString(), kind, detail })}\n`, 'utf8');
      } catch { /* best-effort */ }
    },
  };
}
