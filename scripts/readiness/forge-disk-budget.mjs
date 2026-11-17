// Forge disk budget: default budget, strict parser and loader (R951c, designs/forge-space-budget.md section 2).
// Node builtins only: this file is installed on the Forge host and streamed over ssh for dry-runs.
// Also the scheduler core (cleaners, refusal counters, atomic state.json). Not wired into forge-cache-prune.mjs or forge-setup.sh yet (S1b).
import {closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statfsSync, unlinkSync, writeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_BUDGET_PATH = '/etc/forge-exec/disk-budget.json';
export const DEFAULT_STATE_PATH = '/var/lib/forge-disk/state.json';

export const DEFAULT_BUDGET = Object.freeze({
  v: 1,
  filesystem: '/',
  alerts: {warnPct: 70, pagePct: 80, refuseRunsPct: 90},
  consumers: {
    cache: {pct: 20, maxAgeHours: 12, yieldAtPct: 65},
    slots: {pct: 7, leakAgeHours: 3},
    presync: {pct: 1, maxAgeHours: 72, minAgeHours: 24},
    bases: {pct: 2},
    receipts: {pct: 0.5, maxFiles: 5000, telemetryAgeHours: 48, consumedAgeHours: 24},
    tmp: {pct: 2.5, maxAgeHours: 48},
    ci: {pct: 12, paths: ['/home/runner-we', '/home/runner-pl']},
    system: {pct: 4},
  },
});

// Allowed keys per consumer; every listed key is required except ci.paths.
const SHAPE = {
  cache: ['pct', 'maxAgeHours', 'yieldAtPct'],
  slots: ['pct', 'leakAgeHours'],
  presync: ['pct', 'maxAgeHours', 'minAgeHours'],
  bases: ['pct'],
  receipts: ['pct', 'maxFiles', 'telemetryAgeHours', 'consumedAgeHours'],
  tmp: ['pct', 'maxAgeHours'],
  ci: ['pct', 'paths'],
  system: ['pct'],
};
const ALERT_KEYS = ['warnPct', 'pagePct', 'refuseRunsPct'];
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = x => typeof x === 'number' && Number.isFinite(x) && x > 0;

const deepClone = o => JSON.parse(JSON.stringify(o));
const bad = reason => ({ok: false, reason});

function unknownKey(obj, allowed, where) {
  const k = Object.keys(obj).find(x => !allowed.includes(x));
  return k === undefined ? null : bad(`invalid:unknown-key:${where}${k}`);
}

export function parseBudget(raw) {
  if (!isObj(raw)) return bad('invalid:not-an-object');
  let r = unknownKey(raw, ['v', 'filesystem', 'alerts', 'consumers'], '');
  if (r) return r;
  if (raw.v !== 1) return bad('invalid:version');
  if (typeof raw.filesystem !== 'string' || !raw.filesystem.startsWith('/')) return bad('invalid:filesystem');
  if (!isObj(raw.alerts)) return bad('invalid:alerts');
  if ((r = unknownKey(raw.alerts, ALERT_KEYS, 'alerts.'))) return r;
  for (const k of ALERT_KEYS) if (!isNum(raw.alerts[k]) || raw.alerts[k] > 100) return bad(`invalid:alerts.${k}`);
  const {warnPct, pagePct, refuseRunsPct} = raw.alerts;
  if (!(warnPct < pagePct && pagePct < refuseRunsPct)) return bad('invalid:alerts-order');
  if (!isObj(raw.consumers)) return bad('invalid:consumers');
  if ((r = unknownKey(raw.consumers, Object.keys(SHAPE), 'consumers.'))) return r;
  let sum = 0;
  for (const [name, keys] of Object.entries(SHAPE)) {
    const c = raw.consumers[name];
    if (!isObj(c)) return bad(`invalid:missing-consumer:${name}`);
    if ((r = unknownKey(c, keys, `consumers.${name}.`))) return r;
    for (const k of keys) {
      if (k === 'paths') {
        if (!Array.isArray(c.paths) || !c.paths.every(p => typeof p === 'string' && p.startsWith('/'))) return bad(`invalid:consumers.${name}.paths`);
      } else if (!isNum(c[k])) return bad(`invalid:consumers.${name}.${k}`);
    }
    if (Math.round(c.pct * 1e4) / 1e4 !== c.pct) return bad(`invalid:consumers.${name}.pct-precision`);
    if (c.pct > 100) return bad(`invalid:consumers.${name}.pct`);
    if (c.yieldAtPct !== undefined && c.yieldAtPct > 100) return bad(`invalid:consumers.${name}.yieldAtPct`);
    sum += c.pct;
  }
  if (sum > warnPct) return bad('invalid:shares-exceed-warn');
  return {ok: true, budget: deepClone(raw)};
}

// Bytes for pct% of total, rounded down. BigInt keeps 1.8 TB * millionths-of-a-percent exact.
export function capBytes(totalBytes, pct) {
  return Number((BigInt(totalBytes) * BigInt(Math.round(pct * 1e6))) / 100000000n);
}

export function capsFor(budget, fsTotalBytes) {
  if (!Number.isSafeInteger(fsTotalBytes) || fsTotalBytes <= 0) return null;
  return Object.fromEntries(Object.entries(budget.consumers).map(([n, c]) => [n, capBytes(fsTotalBytes, c.pct)]));
}

// Never throws and never refuses: a missing or invalid file falls back to DEFAULT_BUDGET and says why.
export function loadBudget({path = DEFAULT_BUDGET_PATH, fsTotalBytes, readFile = readFileSync} = {}) {
  let budget, source = 'file';
  const fallback = reason => { budget = deepClone(DEFAULT_BUDGET); source = `defaults:${reason}`; };
  let text = null;
  try { text = readFile(path, 'utf8'); } catch (e) { fallback(e && e.code === 'ENOENT' ? 'missing-file' : 'unreadable'); }
  if (text !== null) {
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (json === undefined) fallback('invalid-json');
    else {
      const p = parseBudget(json);
      if (p.ok) budget = p.budget; else fallback(p.reason);
    }
  }
  return {budget, source, degraded: source !== 'file', capsBytes: capsFor(budget, fsTotalBytes)};
}

function hostTotalBytes(fsPath) {
  try { const s = statfsSync(fsPath); return Number(s.blocks) * Number(s.bsize); } catch { return 0; }
}

export function runCli(argv = [], {write = s => process.stdout.write(s), path = DEFAULT_BUDGET_PATH, fsTotalBytes} = {}) {
  if (!argv.includes('--json')) { write('usage: forge-disk-budget.mjs --json\n'); return 2; }
  const r = loadBudget({path});
  const total = fsTotalBytes ?? hostTotalBytes(r.budget.filesystem);
  r.capsBytes = capsFor(r.budget, total);
  // Capacity discovery failing is a real failure; a bad budget file is not (it falls back to defaults, see source).
  if (!r.capsBytes) { write(`${JSON.stringify({source: r.source, path, error: 'filesystem-size-unknown'})}\n`); return 1; }
  write(`${JSON.stringify({source: r.source, degraded: r.degraded, path, fsTotalBytes: total, budget: r.budget, capsBytes: r.capsBytes}, null, 2)}\n`);
  return 0;
}

export const CONSUMER_NAMES = Object.freeze(Object.keys(SHAPE));

// One cleaner's result folded into its persisted counters. Only a real "ok" resets the refusal streak;
// a skip (e.g. busy lock) neither counts nor resets. Anything unrecognised counts as a refusal (fail closed).
export function applyOutcome(prev, result, nowMs) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const streak = Number.isSafeInteger(p.consecutiveRefused) && p.consecutiveRefused > 0 ? p.consecutiveRefused : 0;
  const r = result && typeof result === 'object' ? result : {};
  const reason = typeof r.reason === 'string' ? r.reason : '';
  if (r.outcome === 'ok') return {outcome: 'ok', consecutiveRefused: 0, lastRefusal: p.lastRefusal ?? null, reclaimedBytes: Number.isFinite(r.reclaimedBytes) ? r.reclaimedBytes : 0, atMs: nowMs};
  if (r.outcome === 'skipped') return {...p, outcome: 'skipped', consecutiveRefused: streak, lastRefusal: p.lastRefusal ?? null, reclaimedBytes: 0, atMs: nowMs};
  const outcome = r.outcome === 'error' ? 'error' : 'refused';
  return {outcome, consecutiveRefused: streak + 1, lastRefusal: {reason: reason || (r.outcome === 'refused' ? 'refused' : `unrecognized-outcome:${outcomeText(r.outcome)}`), atMs: nowMs}, reclaimedBytes: 0, atMs: nowMs};
}

// Malformed outcomes still count as refusals even when their diagnostic text cannot be produced.
function outcomeText(outcome) {
  try { return String(outcome); } catch { return 'unprintable outcome'; }
}

// Thrown values need not be Errors; even reading a message or coercing it can throw.
function errorText(error) {
  try {
    const message = error?.message;
    return String(message || error);
  } catch { return 'unprintable thrown value'; }
}

// Runs every cleaner in order. A throw is recorded as an error and never stops the next cleaner.
export async function runCleaners({cleaners, budget, prev = {}, now = Date.now}) {
  const out = {};
  let anyFailed = false;
  for (const c of cleaners) {
    try {
      const result = await c.run({budget});
      // Result accessors can throw too; finish folding the result inside this boundary.
      out[c.name] = applyOutcome(prev.cleaners?.[c.name], result, now());
    } catch (e) {
      out[c.name] = applyOutcome(prev.cleaners?.[c.name], {outcome: 'error', reason: `threw: ${errorText(e)}`}, now());
    }
    if (out[c.name].outcome === 'refused' || out[c.name].outcome === 'error') anyFailed = true;
  }
  return {cleaners: out, anyFailed};
}

export const realFs = {
  mkdirSync: (p) => mkdirSync(p, {recursive: true}),
  writeFileSync: (p, d) => {
    const data = Buffer.from(d);
    const fd = openSync(p, 'w', 0o644);
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (written === 0) throw new Error('state write made no progress');
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  },
  renameSync, unlinkSync,
};

// Temp file in the same directory, then rename: readers see the old or the new state, never a partial one.
export function writeStateAtomic(path, state, fs = realFs) {
  const dir = dirname(path), tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  fs.mkdirSync(dir);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmp, path);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
}

// Measures with a time limit per walk; du's partial total is kept when it exits non-zero on unreadable dirs.
export function duBytes(paths, timeoutMs = 60000) {
  let total = 0, measured = paths.length > 0;
  for (const p of paths) {
    const r = spawnSync('du', ['-sxb', p], {encoding: 'utf8', timeout: timeoutMs});
    const n = Number.parseInt(String(r.stdout ?? '').split(/\s/)[0], 10);
    if (Number.isFinite(n)) total += n;
    if (!Number.isFinite(n) || r.error || r.status !== 0) measured = false; // partial du totals must not look complete
  }
  return {bytes: total, measured};
}

export function consumerPaths(name, cfg, root = '/') {
  const j = (p) => join(root, p);
  if (name === 'cache') return [j('srv/forge-cache')];
  if (name === 'slots') { try { return readdirSync(j('srv/forge-exec')).filter((d) => /^slot-\d+$/.test(d)).map((d) => j(`srv/forge-exec/${d}`)); } catch { return []; } }
  if (name === 'presync') return [j('srv/forge-exec/presync')];
  if (name === 'bases') return [j('srv/forge-base')];
  if (name === 'receipts') return [j('srv/forge-receipts')];
  if (name === 'tmp') return [j('tmp')];
  if (name === 'ci') return cfg.paths;
  return [j('var')];
}

export const defaultMeasure = async (name, cfg) => duBytes(consumerPaths(name, cfg));

function hostUsedPct(fsPath) {
  const s = statfsSync(fsPath);
  return Math.round(((Number(s.blocks) - Number(s.bavail)) / Number(s.blocks)) * 1000) / 10;
}

function validPrevState(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  if (j.cleaners === undefined) return true;
  if (!j.cleaners || typeof j.cleaners !== 'object' || Array.isArray(j.cleaners)) return false;
  return Object.values(j.cleaners).every((c) => c && typeof c === 'object' && (c.consecutiveRefused === undefined || (Number.isSafeInteger(c.consecutiveRefused) && c.consecutiveRefused >= 0)));
}

// One scheduler tick: load the budget (never refuses), measure all consumers, run cleaners, write state.json.
export async function runBudget({budgetPath = DEFAULT_BUDGET_PATH, statePath = DEFAULT_STATE_PATH, io = {}, now = Date.now, usedPct, totalBytes, measure = defaultMeasure, cleaners = []} = {}) {
  const readFile = io.readFile ?? readFileSync;
  const loaded = loadBudget({path: budgetPath, readFile});
  const fsPath = loaded.budget.filesystem;
  const total = typeof totalBytes === 'function' ? totalBytes(fsPath) : (totalBytes ?? hostTotalBytes(fsPath));
  const caps = capsFor(loaded.budget, total);
  let prev = {}, prevStateError = null;
  try { const j = JSON.parse(readFile(statePath, 'utf8')); if (validPrevState(j)) prev = j; else prevStateError = 'invalid-schema'; } catch (e) { if (!(e && e.code === 'ENOENT')) prevStateError = 'unreadable-or-corrupt'; } // counters restart, but loudly
  const consumers = {};
  for (const [name, cfg] of Object.entries(loaded.budget.consumers)) {
    let m;
    try { m = await measure(name, cfg); } catch { m = null; }
    const ok = m && Number.isFinite(m.bytes) && m.bytes >= 0 && m.measured === true;
    consumers[name] = {bytes: ok ? m.bytes : null, measured: Boolean(ok), pct: cfg.pct, capBytes: caps ? caps[name] : null};
  }
  const ran = await runCleaners({cleaners, budget: loaded.budget, prev, now});
  let used = null;
  try { used = typeof usedPct === 'function' ? usedPct(fsPath) : hostUsedPct(fsPath); } catch { /* reported as null */ }
  if (!Number.isFinite(used) || used < 0 || used > 100) used = null;
  const state = {v: 1, measuredAtMs: now(), budgetSource: loaded.source, prevStateError, usedPct: used, fsTotalBytes: total || null, consumers, cleaners: ran.cleaners};
  let writeError = null;
  try { writeStateAtomic(statePath, state, io.fs ?? realFs); } catch (e) { writeError = errorText(e); }
  const incomplete = !caps || used === null || Object.values(consumers).some((c) => !c.measured);
  const exitCode = ran.anyFailed || loaded.degraded || writeError !== null || prevStateError || incomplete ? 1 : 0;
  return {exitCode, state, writeError};
}

// Read-only listing for live proof: prints each consumer's bytes against its budget share. Writes nothing.
export async function dryRun({path = DEFAULT_BUDGET_PATH, write = (s) => process.stdout.write(s), measure = defaultMeasure, totalBytes} = {}) {
  const loaded = loadBudget({path});
  const total = totalBytes ?? hostTotalBytes(loaded.budget.filesystem);
  const caps = capsFor(loaded.budget, total);
  const rows = [];
  for (const [name, cfg] of Object.entries(loaded.budget.consumers)) {
    let m; try { m = await measure(name, cfg); } catch { m = {bytes: null, measured: false}; }
    const cap = caps ? caps[name] : null;
    if (!(m && Number.isFinite(m.bytes) && m.bytes >= 0 && m.measured === true)) m = {bytes: null, measured: false};
    rows.push({consumer: name, bytes: m.bytes, measured: m.measured, sharePct: cfg.pct, capBytes: cap, usedOfCapPct: cap && m.bytes != null ? Math.round((m.bytes / cap) * 1000) / 10 : null});
  }
  write(`${JSON.stringify({dryRun: true, source: loaded.source, fsTotalBytes: total, usedPct: (() => { try { return hostUsedPct(loaded.budget.filesystem); } catch { return null; } })(), totalSharePct: rows.reduce((a, r) => a + r.sharePct, 0), consumers: rows}, null, 2)}\n`);
  return caps && !loaded.degraded && rows.every((r) => r.measured) ? 0 : 1;
}

try {
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (process.argv.includes('--dry-run')) dryRun().then((c) => { process.exitCode = c; });
    else process.exitCode = runCli(process.argv.slice(2));
  }
} catch { /* streamed over stdin: no file URL match, the caller invokes runCli */ }
