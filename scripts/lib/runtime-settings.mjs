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
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { withPathLock } from '../readiness/with-lock.mjs';
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

const livePath = (home) => join(home, 'workspace', '.operations', 'settings', 'runtime.json');
/**
 * The real (symlink-resolved) form of a path that may not exist yet. NEVER normalises `..` before resolving (that
 * changes meaning across a symlink): the raw path goes to `realpathSync` (the kernel follows symlinks, then `..`);
 * when it does not exist, the raw string's last segment is peeled off textually and the existing parent is resolved
 * the same way, then the peeled segments are re-appended. A peeled segment that is `.`/`..`/empty cannot be placed
 * without resolving it, so the result is `null` (callers treat that as "may be the live file").
 * @returns {string|null}
 */
export function realPathOf(p) {
  const raw = String(p);
  let head = isAbsolute(raw) ? raw : `${process.cwd()}${sep}${raw}`;
  const rest = [];
  for (;;) {
    try { return rest.length ? join(realpathSync.native(head), ...rest) : realpathSync.native(head); } catch { /* peel one */ }
    const cut = head.replace(/\/+$/, '');
    const i = cut.lastIndexOf(sep);
    if (i <= 0) return null;
    const seg = cut.slice(i + 1);
    if (!seg || seg === '.' || seg === '..') return null;
    rest.unshift(seg);
    head = cut.slice(0, i) || sep;
  }
}
const testing = (env) => isUnderTest(env) || isUnderTest(process.env);
/** True when `p` is (by real path, through any symlink) the host's LIVE runtime file. */
/** Same file by IDENTITY (device + inode, following symlinks) — catches hard-link aliases a path compare cannot. */
const sameFile = (a, b) => {
  try { const x = statSync(a); const y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
};
export function isLiveRuntimeFile(p, { home = homedir() } = {}) {
  const real = realPathOf(p);
  if (real === null) return true; // unplaceable without resolving — fail closed
  return [livePath(home), livePath(homedir())].some((l) => realPathOf(l) === real || sameFile(l, p));
}
/** Under test, refuse ANY path (env override or explicit argument) that is the live file. */
const testSafe = (p, env) => (p && testing(env) && isLiveRuntimeFile(p) ? null : p);

/** The runtime file path, or `null` when the layer is off. Under test it is off unless the env names a file, and a
 *  path that resolves (by real path) to the host's LIVE file is refused — a test never reads or writes the live layer. */
export function runtimeSettingsPath({ env = process.env, home = homedir() } = {}) {
  const override = String(env?.[RUNTIME_SETTINGS_ENV] ?? '').trim();
  if (override) return testing(env) && isLiveRuntimeFile(override, { home }) ? null : override;
  if (testing(env)) return null;
  return livePath(home);
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
export function readRuntimeFile({ env = process.env, path: given, stat = statSync, readFile = readFileSync } = {}) {
  const path = given === undefined ? runtimeSettingsPath({ env }) : testSafe(given, env);
  if (!path) return { path: path ?? null, entries: {}, warnings: [] };
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
export function planRuntimeSetting({ action, key, value, actor, reason, now = new Date().toISOString(), entries = {}, path, auditTail = [] }) {
  const fail = (error) => ({ ok: false, action, error });
  if (!path) return fail('runtime settings layer is off (no path; under test set WE_RUNTIME_SETTINGS_FILE)');
  if (action === 'list') {
    return { ok: true, action, path, entries, allowlist: Object.fromEntries(Object.entries(RUNTIME_SETTINGS_ALLOWLIST).map(([k, r]) => [k, { bounds: r.bounds, note: r.note }])) };
  }
  if (!['set', 'unset', 'get'].includes(action)) return fail(`unknown action ${JSON.stringify(action)} (set|unset|get|list)`);
  const rule = ruleFor(key);
  if (!rule) return fail(`${JSON.stringify(key)} is not runtime-settable; allowed: ${Object.keys(RUNTIME_SETTINGS_ALLOWLIST).join(', ')}`);
  const before = entries[key]?.value;
  if (action === 'get') return { ok: true, action, key, path, before, entry: entries[key] ?? null, bounds: rule.bounds, note: rule.note, audit: runtimeAuditStatus(auditTail, key) };
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

/** IO: write ALL of `text` to `fd` (writeSync may write fewer bytes than asked), then fsync. */
function writeAllAndSync(fd, text) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error('runtime settings: write made no progress');
    off += n;
  }
  fsyncSync(fd);
}
/** IO: append one durable audit line (full write + fsync). */
function appendAuditLine(path, record) {
  const fd = openSync(runtimeAuditPath(path), 'a', 0o644);
  try { writeAllAndSync(fd, `${JSON.stringify(record)}\n`); } finally { closeSync(fd); }
}

/** IO: the last `max` audit records (parsed); [] when absent/unreadable. */
export function readRuntimeAuditTail(path, { max = 200 } = {}) {
  if (!path) return [];
  try {
    return String(readFileSync(runtimeAuditPath(path), 'utf8')).trim().split('\n').slice(-max)
      .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return []; }
}

/** PURE: the audit status of `key`'s most recent change — `applied`, `failed`, or `unconfirmed` (an intent with no
 *  outcome line: the write may or may not have taken effect), plus any warnings recorded with it. */
export function runtimeAuditStatus(records, key) {
  const intent = records.filter((r) => r?.key === key && r.outcome === 'intent').at(-1);
  if (!intent) return { status: 'none' };
  const outcomes = records.filter((r) => r?.id === intent.id && r.outcome !== 'intent');
  const last = outcomes.at(-1);
  const warnings = outcomes.flatMap((r) => r.warnings ?? []);
  return { status: last?.outcome ?? 'unconfirmed', id: intent.id, at: intent.at, actor: intent.actor, ...(last?.error ? { error: last.error } : {}), ...(warnings.length ? { warnings } : {}) };
}

/**
 * IO: under the repo's file lock (`we:scripts/readiness/with-lock.mjs#withPathLock` — owner-checked reserve,
 * dead-owner fast path, compare-and-remove reclaim, `touch()` that throws ELOCKLOST once reclaimed), refuse when the
 * file changed since it was planned (compare-and-swap — a concurrent write is never lost); append a durable `intent`
 * audit line FIRST, write the new contents (full write + fsync), re-confirm the lock is still ours (`touch`) right
 * before the rename, rename, fsync the directory, then append the `applied` — or, on failure, `failed` — outcome.
 * A directory-fsync error is recorded as a warning on the `applied` line and returned. A failed `applied` append
 * (the change IS live) is returned as a warning, logged, and shows as `unconfirmed` in `runtime-setting get`.
 * @returns {{warnings:string[]}}
 */
export function writeRuntimeSettings({ path: given, next, audit, expected }, { env = process.env, log = (l) => console.error(l) } = {}) {
  const path = testSafe(given, env);
  if (!path) throw new Error('runtime settings: refusing to write the live runtime file under test');
  mkdirSync(dirname(path), { recursive: true });
  return withPathLock(path, ({ touch }) => {
    if (expected !== undefined) {
      const now = readRuntimeFile({ path, env });
      if (now.warnings.length || JSON.stringify(now.entries) !== JSON.stringify(expected)) {
        throw new Error('runtime settings changed since this command read them — re-run it');
      }
    }
    const id = randomUUID();
    const warnings = [];
    appendAuditLine(path, { ...audit, id, outcome: 'intent' });
    const tmp = `${path}.${process.pid}.${id}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o644);
      try { writeAllAndSync(fd, `${JSON.stringify(next, null, 2)}\n`); } finally { closeSync(fd); }
      touch(); // throws ELOCKLOST if another writer reclaimed the lock — then nothing is published
      renameSync(tmp, path);
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
      try { appendAuditLine(path, { id, key: audit?.key, outcome: 'failed', error: String(e?.message ?? e).split('\n')[0], at: new Date().toISOString() }); } catch { /* best effort */ }
      throw e;
    }
    try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } }
    catch (e) { warnings.push(`directory fsync failed (${String(e?.message ?? e).split('\n')[0]}) — the change is live but may not survive a crash`); }
    try { appendAuditLine(path, { id, key: audit?.key, outcome: 'applied', at: new Date().toISOString(), ...(warnings.length ? { warnings } : {}) }); }
    catch (e) { warnings.push(`the change is LIVE but its "applied" audit line failed (${String(e?.message ?? e).split('\n')[0]}) — \`runtime-setting get\` shows it as unconfirmed`); }
    for (const w of warnings) { try { log(`runtime-setting: WARNING ${w}`); } catch { /* ignore */ } }
    return { warnings };
  });
}
