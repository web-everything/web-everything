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

export async function sweepOurTmp({
  tmpRoot, prefixes, olderThanMs = TMP_SWEEP_DEFAULTS.tmpSweepOlderThanMs, now = Date.now(),
  batchSize = TMP_SWEEP_DEFAULTS.tmpSweepBatchSize, pauseMs = TMP_SWEEP_DEFAULTS.tmpSweepPauseMs,
  maxDeletes = TMP_SWEEP_DEFAULTS.tmpSweepMaxDeletesPerRun, timeBudgetMs = TMP_SWEEP_DEFAULTS.tmpSweepTimeBudgetMs,
  busy = readBusyTopLevel(tmpRoot), dryRun = false, fs = nodeFs, sleep = setTimeout, log = () => {},
}) {
  const started = Date.now();
  const names = fs.readdirSync(tmpRoot);
  const pattern = ourTmpEntryPattern(prefixes);
  const matches = names.filter((name) => pattern.test(name));
  const result = { listed: names.length, matched: matches.length, busy: 0, young: 0, eligible: 0, deleted: 0, errors: 0, complete: true, durationMs: 0 };
  let inBatch = 0;
  for (const name of matches) {
    if (result.deleted >= maxDeletes || Date.now() - started >= timeBudgetMs) { result.complete = false; break; }
    if (busy.has(name)) { result.busy++; continue; }
    try {
      const path = join(tmpRoot, name);
      if (now - fs.lstatSync(path).mtimeMs < olderThanMs) { result.young++; continue; }
      result.eligible++;
      if (inBatch >= batchSize) {
        await sleep(pauseMs);
        inBatch = 0;
      }
      if (Date.now() - started >= timeBudgetMs) { result.complete = false; break; }
      if (!dryRun) fs.rmSync(path, { recursive: true, force: true });
      result.deleted++;
      inBatch++;
    } catch { result.errors++; }
  }
  result.durationMs = Date.now() - started;
  log(formatTmpSweepLine(result));
  return result;
}

export function formatTmpSweepLine(result) {
  return `tmp-sweep: deleted ${result.deleted}/${result.eligible} eligible (matched ${result.matched}, young ${result.young}, busy ${result.busy}, errors ${result.errors}) in ${result.durationMs}ms, ${result.complete ? 'complete' : 'incomplete'}`;
}
