// Forge disk budget: default budget, strict parser and loader (R951c, designs/forge-space-budget.md section 2).
// Node builtins only: this file is installed on the Forge host and streamed over ssh for dry-runs.
// Not wired into forge-cache-prune.mjs or forge-setup.sh yet (next slice).
import {readFileSync, statfsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const DEFAULT_BUDGET_PATH = '/etc/forge-exec/disk-budget.json';

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
    if (c.pct > 100) return bad(`invalid:consumers.${name}.pct`);
    sum += c.pct;
  }
  if (sum > warnPct) return bad('invalid:shares-exceed-warn');
  return {ok: true, budget: deepClone(raw)};
}

// Bytes for pct% of total, rounded down. BigInt keeps 1.8 TB * hundredths-of-a-percent exact.
export function capBytes(totalBytes, pct) {
  return Number((BigInt(totalBytes) * BigInt(Math.round(pct * 100))) / 10000n);
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
  return {budget, source, capsBytes: capsFor(budget, fsTotalBytes)};
}

function hostTotalBytes(fsPath) {
  try { const s = statfsSync(fsPath); return Number(s.blocks) * Number(s.bsize); } catch { return 0; }
}

export function runCli(argv = [], {write = s => process.stdout.write(s), path = DEFAULT_BUDGET_PATH, fsTotalBytes} = {}) {
  if (!argv.includes('--json')) { write('usage: forge-disk-budget.mjs --json\n'); return 2; }
  const first = loadBudget({path, fsTotalBytes: 1});
  const total = fsTotalBytes ?? hostTotalBytes(first.budget.filesystem);
  const r = loadBudget({path, fsTotalBytes: total});
  write(`${JSON.stringify({source: r.source, path, fsTotalBytes: total, budget: r.budget, capsBytes: r.capsBytes}, null, 2)}\n`);
  return 0;
}

try {
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = runCli(process.argv.slice(2));
} catch { /* streamed over stdin: no file URL match, the caller invokes runCli */ }
