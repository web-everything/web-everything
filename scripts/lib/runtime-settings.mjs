/**
 * @file scripts/lib/runtime-settings.mjs
 * @description The RUNTIME-OPERATOR layer of the policy cascade (operator request 2026-10-20: "add debug for more hot
 *   swapping config including reviewer count"). An operational knob such as the review cap used to need a code
 *   overlay + daemon rebuild to change (a 5→8 change took over an hour to reach the review daemon while its rebuild
 *   was held). This layer lets an operator change an ALLOWLISTED knob so it applies on the daemon's next tick, with no
 *   rebuild.
 *
 *   FILE: `~/workspace/.operations/settings/runtime.json` — OUTSIDE every daemon clone, so a rebuild never resets it.
 *   `WE_RUNTIME_SETTINGS_FILE` replaces the path (tests, a one-off proof). Under test the layer is OFF unless that env
 *   is set, so no test ever reads the host's live file. Shape:
 *     { "settings": { "<policy>.<leaf>": { "value": 8, "setBy": "<login>", "setAt": "<iso>", "reason": "…" } } }
 *   Every write appends one audit line (who/when/why/old/new) to the sibling `runtime.audit.jsonl`.
 *
 *   READ FRESH: {@link readRuntimeLayer} stats and reads the file on EVERY call (it is tiny; no cache across ticks).
 *
 *   PRECEDENCE (per leaf): env > runtime > tool/repo > platform > standard. Wired through
 *   `we:scripts/lib/policy-cascade.mjs#cascadePolicy` (every cascade reader gets it for an allowlisted leaf) and the
 *   drain's own batching resolver (`we:scripts/lib/merge-queue-adaptive-batching.mjs#resolveBatchingSettings`).
 *
 *   SAFETY: only {@link RUNTIME_SETTINGS_ALLOWLIST} keys are honoured; each has a declared validator with hard
 *   bounds, applied on write (CLI refuses) AND on read (a hand-edited bad value is ignored with a warning, never
 *   widened past its bounds). An unreadable / malformed file disables the layer for that read and falls back to the
 *   lower layers — never throws. Guards and trust settings (auth, round caps for limit lifting, red-team gate rules)
 *   are deliberately NOT on the allowlist: changing those stays a reviewed code change.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isUnderTest } from './under-test.mjs';

export const RUNTIME_SETTINGS_ENV = 'WE_RUNTIME_SETTINGS_FILE';
export const RUNTIME_SETTINGS_MAX_BYTES = 64 * 1024;

const int = (min, max) => (v) => Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * THE allowlist: `<policy>.<leaf>` → { valid, bounds, note }. `policy` is the cascade policy name (or the settings block
 * name for the drain's batching resolver). Bounds are hard: a runtime value outside them is refused on write and
 * ignored on read.
 */
export const RUNTIME_SETTINGS_ALLOWLIST = Object.freeze({
  'reviewConcurrency.maxLiveReviewRounds': Object.freeze({
    valid: int(1, 12), bounds: 'integer 1..12',
    note: 'host-wide cap on live review rounds (review daemon). Safety rule (operator 2026-10-20, replaces the old >36 load rule): the memory floor below drops it to capFloorValue while free RAM+swap < capMemoryFloorMb.',
  }),
  'reviewConcurrency.capMemoryFloorMb': Object.freeze({
    valid: int(0, 65536), bounds: 'integer 0..65536 MB (0 = rule off)', note: 'review cap memory floor: free RAM+swap below this drops the cap to capFloorValue (standard 3072).',
  }),
  'reviewConcurrency.capFloorValue': Object.freeze({
    valid: int(1, 12), bounds: 'integer 1..12', note: 'the live-review cap while the memory floor is engaged (standard 5; never raises the cap).',
  }),
  'reviewConcurrency.capMemoryHysteresisMb': Object.freeze({
    valid: int(256, 8192), bounds: 'integer 256..8192 MB (never 0: a zero band would flap)', note: 'the floor releases only once free RAM+swap ≥ floor + this (standard 1024), to avoid flapping.',
  }),
  'reviewConcurrency.redTeamReservedSeats': Object.freeze({
    valid: int(0, 8), bounds: 'integer 0..8', note: 'review dispatch seats reserved for red-team requests (review daemon).',
  }),
  'mergeQueueBatching.maxGroupsInFlight': Object.freeze({
    valid: int(1, 8), bounds: 'integer 1..8 (GitHub max_entries_to_build is 8)', note: 'drain: active merge-queue groups.',
  }),
  'mergeQueueBatching.groupFormMinutes': Object.freeze({
    valid: int(0, 60), bounds: 'integer 0..60', note: 'drain: minutes a forming merge-queue group waits for more PRs.',
  }),
});

/** The runtime file path, or `null` when the layer is off (under test without an explicit path). */
export function runtimeSettingsPath({ env = process.env, home = homedir() } = {}) {
  const override = String(env?.[RUNTIME_SETTINGS_ENV] ?? '').trim();
  if (override) return override;
  if (isUnderTest(env) || isUnderTest(process.env)) return null;
  return join(home, 'workspace', '.operations', 'settings', 'runtime.json');
}

export const runtimeAuditPath = (path) => path.replace(/\.json$/, '') + '.audit.jsonl';
export const RUNTIME_ACTOR_MAX = 64;
export const RUNTIME_REASON_MAX = 500;
const ruleFor = (key) => (Object.hasOwn(RUNTIME_SETTINGS_ALLOWLIST, key) ? RUNTIME_SETTINGS_ALLOWLIST[key] : undefined);

/** PURE: keep only the allowlisted, in-bounds leaves of an (injected or file-read) runtime block for `policy`. */
export function filterRuntimeBlock(policy, block) {
  if (!isObj(block)) return { block: undefined, warnings: [] };
  const out = {}; const warnings = [];
  for (const [leaf, v] of Object.entries(block)) {
    const key = `${policy}.${leaf}`;
    const rule = ruleFor(key);
    if (!rule) { warnings.push(`runtime settings: ${key} is not runtime-settable — ignored`); continue; }
    if (!rule.valid(v)) { warnings.push(`runtime settings: ${key}=${JSON.stringify(v)} outside ${rule.bounds} — ignored`); continue; }
    out[leaf] = v;
  }
  return { block: Object.keys(out).length ? out : undefined, warnings };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * IO: read the whole runtime file fresh. Never throws.
 * @returns {{path:string|null, entries:Record<string,{value:unknown}>, warnings:string[]}}
 */
export function readRuntimeFile({ env = process.env, path = runtimeSettingsPath({ env }), stat = statSync, readFile = readFileSync } = {}) {
  if (!path) return { path, entries: {}, warnings: [] };
  try {
    if (stat(path).size > RUNTIME_SETTINGS_MAX_BYTES) return { path, entries: {}, warnings: [`runtime settings ${path}: larger than ${RUNTIME_SETTINGS_MAX_BYTES} bytes — layer ignored`] };
    const data = JSON.parse(String(readFile(path, 'utf8')));
    if (!isObj(data) || (data.settings !== undefined && !isObj(data.settings))) return { path, entries: {}, warnings: [`runtime settings ${path}: not {settings:{…}} — layer ignored`] };
    const entries = {};
    for (const [k, e] of Object.entries(data.settings ?? {})) if (isObj(e) && Object.hasOwn(e, 'value')) entries[k] = e;
    return { path, entries, warnings: [] };
  } catch (e) {
    if (e?.code === 'ENOENT') return { path, entries: {}, warnings: [] };
    return { path, entries: {}, warnings: [`runtime settings ${path}: unreadable (${String(e?.message ?? e).split('\n')[0]}) — layer ignored`] };
  }
}

/**
 * IO: the runtime block for ONE policy — `{leaf: value}` for every allowlisted, valid entry under `policy.`, or
 * `undefined` when none is set. Read fresh on every call. Never throws.
 * @returns {{block: Record<string,unknown>|undefined, warnings: string[]}}
 */
export function readRuntimeLayer(policy, o = {}) {
  const { entries, warnings } = readRuntimeFile(o);
  const raw = {};
  const prefix = `${policy}.`;
  for (const [key, e] of Object.entries(entries)) if (key.startsWith(prefix)) raw[key.slice(prefix.length)] = e.value;
  const f = filterRuntimeBlock(policy, raw);
  return { block: f.block, warnings: [...warnings, ...f.warnings] };
}

/** PURE: parse a CLI value — JSON when it parses (numbers, booleans), else the raw string. */
export function parseRuntimeValue(raw) {
  const s = String(raw ?? '').trim();
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * PURE: plan one CLI action over the current file contents. Never touches disk.
 * @param {{action:'set'|'unset'|'get'|'list', key?:string, value?:string, actor?:string, reason?:string, now?:string,
 *   entries:Record<string,object>, path:string|null}} o
 * @returns {{ok:boolean, action:string, error?:string, key?:string, before?:unknown, after?:unknown,
 *   next?:{settings:object}, audit?:object, entries?:object, allowlist?:object}}
 */
export function planRuntimeSetting({ action, key, value, actor, reason, now = new Date().toISOString(), entries = {}, path }) {
  const fail = (error) => ({ ok: false, action, error });
  if (!path) return fail('runtime settings layer is off (no path; under test set WE_RUNTIME_SETTINGS_FILE)');
  if (action === 'list') {
    return { ok: true, action, path, entries, allowlist: Object.fromEntries(Object.entries(RUNTIME_SETTINGS_ALLOWLIST).map(([k, r]) => [k, { bounds: r.bounds, note: r.note }])) };
  }
  if (!['set', 'unset', 'get'].includes(action)) return fail(`unknown action ${JSON.stringify(action)} (set|unset|get|list)`);
  const rule = ruleFor(key);
  if (!rule) return fail(`${JSON.stringify(key)} is not runtime-settable; allowed: ${Object.keys(RUNTIME_SETTINGS_ALLOWLIST).join(', ')}`);
  const before = entries[key]?.value;
  if (action === 'get') return { ok: true, action, key, path, before, entry: entries[key] ?? null, bounds: rule.bounds, note: rule.note };
  if (!String(actor ?? '').trim()) return fail('--actor=<login> is required');
  if (!String(reason ?? '').trim()) return fail('--reason=… is required');
  if (String(actor).trim().length > RUNTIME_ACTOR_MAX) return fail(`--actor is longer than ${RUNTIME_ACTOR_MAX} characters`);
  if (String(reason).trim().length > RUNTIME_REASON_MAX) return fail(`--reason is longer than ${RUNTIME_REASON_MAX} characters`);
  const next = { settings: { ...entries } };
  let after;
  if (action === 'set') {
    after = parseRuntimeValue(value);
    if (!rule.valid(after)) return fail(`${key}=${JSON.stringify(after)} is outside ${rule.bounds}`);
    next.settings[key] = { value: after, setBy: String(actor).trim(), setAt: now, reason: String(reason).trim() };
  } else {
    if (!Object.hasOwn(entries, key)) return fail(`${key} has no runtime value to unset`);
    delete next.settings[key];
  }
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > RUNTIME_SETTINGS_MAX_BYTES) return fail(`the resulting file would exceed ${RUNTIME_SETTINGS_MAX_BYTES} bytes (its reader would ignore it)`);
  const audit = { at: now, action, key, before: before ?? null, after: after ?? null, actor: String(actor).trim(), reason: String(reason).trim() };
  return { ok: true, action, key, path, before, after, expected: entries, next, audit };
}

const LOCK_STALE_MS = 30_000;
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** IO: an exclusive create-lock beside the file (stale after 30 s). Throws when it cannot be taken in ~5 s. */
function withRuntimeLock(path, fn, { stat = statSync } = {}) {
  const lock = `${path}.lock`;
  for (let i = 0; ; i++) {
    try { closeSync(openSync(lock, 'wx')); break; } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      try { if (Date.now() - stat(lock).mtimeMs > LOCK_STALE_MS) { rmSync(lock, { force: true }); continue; } } catch { /* raced */ }
      if (i >= 50) throw new Error(`runtime settings: ${lock} is held — try again`);
      sleepMs(100);
    }
  }
  try { return fn(); } finally { rmSync(lock, { force: true }); }
}

/**
 * IO: under an exclusive lock, refuse when the file changed since it was planned (compare-and-swap — a concurrent
 * write is never lost), append the audit line FIRST (a change is never effective without its record), then write the
 * new contents atomically (temp + fsync + rename + directory fsync). Throws on failure.
 */
export function writeRuntimeSettings({ path, next, audit, expected }) {
  mkdirSync(dirname(path), { recursive: true });
  return withRuntimeLock(path, () => {
    if (expected !== undefined) {
      const now = readRuntimeFile({ path });
      if (now.warnings.length || JSON.stringify(now.entries) !== JSON.stringify(expected)) {
        throw new Error('runtime settings changed since this command read them — re-run it');
      }
    }
    appendFileSync(runtimeAuditPath(path), `${JSON.stringify(audit)}\n`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    const fd = openSync(tmp, 'w', 0o644);
    try { writeSync(fd, `${JSON.stringify(next, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* best effort */ }
  });
}
