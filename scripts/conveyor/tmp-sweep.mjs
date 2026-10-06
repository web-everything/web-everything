// Daily sweep of our own leaked temp entries (see we:scripts/lib/our-tmp-prefixes.mjs for the allowlist).
// One `lsof -n -d cwd` scan (never `lsof +D`); unknown busy state means no sweep.
import { execFileSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { ourTmpEntryPattern } from '../lib/our-tmp-prefixes.mjs';
import { TMP_SWEEP_DEFAULTS } from './tmp-sweep-config.mjs';

export { TMP_SWEEP_DEFAULTS };

export function readBusyTopLevel(tmpRoot, { run = execFileSync } = {}) {
  const roots = new Set([resolve(tmpRoot), nodeFs.realpathSync(tmpRoot)]);
  let output;
  try {
    output = run('lsof', ['-n', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // lsof exits non-zero on routine permission gaps, and its partial stdout is still a full scan. A timeout kill,
    // a signal or a spawn/buffer error (ETIMEDOUT, ENOBUFS, ...) truncates stdout: that is unknown busy state.
    if (error.killed || error.signal || error.code) throw error;
    output = error.stdout;
  }
  const paths = String(output ?? '').split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
  if (!paths.length) throw new Error('tmp-sweep: lsof returned no usable cwd output');
  const busy = new Set();
  for (const path of paths) {
    for (const root of roots) {
      const base = root.endsWith(sep) ? root : root + sep;
      if (path.startsWith(base)) {
        const first = path.slice(base.length).split(sep)[0];
        if (first) busy.add(first);
      }
    }
  }
  return busy;
}

// Config knobs come from an operator-edited config.json: a string or NaN must never reach a comparison (every
// `age < NaN` is false, which would read as "old enough"), so anything not a finite number >= min takes the default.
const knob = (value, fallback, min = 0) => (typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback);

export async function sweepOurTmp({
  tmpRoot, prefixes, olderThanMs: olderThanOpt, now = Date.now(),
  batchSize: batchSizeOpt, pauseMs: pauseMsOpt, maxDeletes: maxDeletesOpt, timeBudgetMs: timeBudgetOpt,
  scanBudgetMs: scanBudgetOpt, cursor,
  busy = readBusyTopLevel(tmpRoot), dryRun = false, fs = nodeFs, sleep = setTimeout, log = () => {},
}) {
  const olderThanMs = knob(olderThanOpt, TMP_SWEEP_DEFAULTS.tmpSweepOlderThanMs);
  const batchSize = knob(batchSizeOpt, TMP_SWEEP_DEFAULTS.tmpSweepBatchSize, 1);
  const pauseMs = knob(pauseMsOpt, TMP_SWEEP_DEFAULTS.tmpSweepPauseMs);
  const maxDeletes = knob(maxDeletesOpt, TMP_SWEEP_DEFAULTS.tmpSweepMaxDeletesPerRun);
  const timeBudgetMs = knob(timeBudgetOpt, TMP_SWEEP_DEFAULTS.tmpSweepTimeBudgetMs);
  const scanBudgetMs = knob(scanBudgetOpt, TMP_SWEEP_DEFAULTS.tmpSweepScanBudgetMs);
  const started = Date.now();
  const names = fs.readdirSync(tmpRoot);
  const pattern = ourTmpEntryPattern(prefixes);
  const matches = names.filter((name) => pattern.test(name)).sort();
  // Matching names end in a separator plus six random characters; the rest is the exact allowlist prefix.
  const remaining = new Map();
  for (const name of matches) {
    const prefix = name.slice(0, -7);
    remaining.set(prefix, (remaining.get(prefix) || 0) + 1);
  }
  const result = { listed: names.length, matched: matches.length, busy: 0, young: 0, eligible: 0, deleted: 0, errors: 0, complete: true, durationMs: 0, nextCursor: null, topPrefixes: [] };
  let inBatch = 0;
  let deleteMs = 0;
  // A removed cursor still defines a position. Missing/non-string cursors start a fresh lap.
  let index = typeof cursor === 'string' ? matches.findIndex((name) => name > cursor) : 0;
  if (index < 0) index = matches.length;
  const startIndex = index;
  let lastExamined = typeof cursor === 'string' ? cursor : null;
  const exhausted = () => Date.now() - started >= scanBudgetMs || deleteMs >= timeBudgetMs;
  for (; index < matches.length; index++) {
    if (result.deleted >= maxDeletes || exhausted()) break;
    const name = matches[index];
    lastExamined = name;
    if (busy.has(name)) { result.busy++; continue; }
    try {
      const path = join(tmpRoot, name);
      if (!(now - fs.lstatSync(path).mtimeMs >= olderThanMs)) { result.young++; continue; } // fails closed on NaN
      result.eligible++;
      if (!exhausted() && inBatch >= batchSize) {
        const pauseStarted = Date.now();
        try { await sleep(pauseMs); } finally { deleteMs += Date.now() - pauseStarted; }
        inBatch = 0;
      }
      if (exhausted()) { lastExamined = index > startIndex ? matches[index - 1] : (typeof cursor === 'string' ? cursor : null); break; } // retry this entry next run
      if (!dryRun) {
        const deleteStarted = Date.now();
        try { fs.rmSync(path, { recursive: true, force: true }); } finally { deleteMs += Date.now() - deleteStarted; }
        const prefix = name.slice(0, -7);
        remaining.set(prefix, remaining.get(prefix) - 1);
      }
      result.deleted++;
      inBatch++;
    } catch { result.errors++; }
  }
  result.complete = index >= matches.length;
  result.nextCursor = result.complete ? null : lastExamined;
  result.topPrefixes = [...remaining].filter(([, count]) => count > 0)
    .sort(([a, ac], [b, bc]) => bc - ac || (a < b ? -1 : a > b ? 1 : 0)).slice(0, 5);
  result.durationMs = Date.now() - started;
  log(formatTmpSweepLine(result));
  return result;
}

export function formatTmpSweepLine(result) {
  return `tmp-sweep: deleted ${result.deleted}/${result.eligible} eligible (listed ${result.listed}, matched ${result.matched}, young ${result.young}, busy ${result.busy}, errors ${result.errors}) in ${result.durationMs}ms, ${result.complete ? 'complete' : 'incomplete'}, top prefixes ${JSON.stringify(result.topPrefixes)}`;
}
