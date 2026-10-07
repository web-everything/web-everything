#!/usr/bin/env node
/**
 * @file scripts/test-cache/trace-report.mjs
 * @description prepare-124 S3 — reads the shadow logs and prints what the runtime tracer found: how many of the
 * subprocess/git test files it covered, why the rest were denied, how many are admitted (K clean traced runs), and the
 * shadow hit rate for tier A (static key only) and tier B (needs a trace) SEPARATELY. Read-only.
 *
 *   node scripts/test-cache/trace-report.mjs [--dir=<store>] [--run=<runId>[,<runId>...]] [--days=<n>] [--json]
 *
 * With no `--run`, each file is judged by its latest record in the last `--days` (default 1) days of logs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheDir } from '../lib/test-result-cache.mjs';
import { localDateString } from '../lib/local-date.mjs';

/** Static tiers that spawn processes or touch git/network: the "368" of prepare-124 section 0. */
export const SUBPROCESS_TIERS = ['tierB', 'checkout', 'other-subprocess', 'network'];

/** Latest record per file from parsed shadow-log rows (`runId` order = file name order). */
export function latestPerFile(rows) {
  const out = new Map();
  for (const r of rows) out.set(r.file, r);
  return [...out.values()];
}

const pct = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : 0);
const denyKind = (d) => String(d).split(':')[0];

/** Pure summary of a set of per-file records. */
export function summarize(records) {
  const sub = records.filter((r) => SUBPROCESS_TIERS.includes(r.tier));
  const traced = sub.filter((r) => r.trace);
  const denied = traced.filter((r) => r.trace.denies.length > 0);
  const byReason = {};
  for (const r of denied) for (const k of new Set(r.trace.denies.map(denyKind))) byReason[k] = (byReason[k] ?? 0) + 1;
  const clean = traced.filter((r) => r.trace.denies.length === 0);
  const tierB = sub.filter((r) => r.tier === 'tierB');
  const tierBTraced = tierB.filter((r) => r.trace);
  const tierBClean = tierBTraced.filter((r) => r.trace.denies.length === 0);
  const group = (list) => {
    const cacheable = list.filter((r) => r.reason !== undefined && !String(r.reason).startsWith('not-cacheable'));
    const hits = cacheable.filter((r) => r.wouldSkip);
    const ms = (xs) => xs.reduce((n, r) => n + (r.durationMs ?? 0), 0);
    return { files: list.length, cacheable: cacheable.length, wouldSkip: hits.length, hitRatePct: pct(hits.length, cacheable.length), hitTimeSharePct: pct(ms(hits), ms(cacheable)), falseSkips: list.filter((r) => r.falseSkip).length, keyMisses: list.filter((r) => r.keyMiss).length };
  };
  return {
    files: records.length,
    subprocessFiles: sub.length,
    traced: traced.length,
    tracedClean: clean.length,
    tracedDenied: denied.length,
    deniedByReason: byReason,
    tierB: { files: tierB.length, traced: tierBTraced.length, clean: tierBClean.length, admitted: tierBTraced.filter((r) => r.trace.admitted).length, cleanSharePct: pct(tierBClean.length, tierB.length) },
    cleanShareOfSubprocessPct: pct(clean.length, sub.length),
    tierA: group(records.filter((r) => !r.needsTrace)),
    tierBHit: group(records.filter((r) => r.needsTrace)),
  };
}

export function readLogs(dir, { runIds, days = 1, now = new Date() } = {}) {
  const base = join(dir, 'shadow');
  let dates = [];
  try { dates = readdirSync(base).sort(); } catch { return []; }
  const cutoff = localDateString(new Date(now.getTime() - days * 86400000));
  const rows = [];
  for (const d of dates.filter((x) => x >= cutoff)) {
    for (const f of readdirSync(join(base, d)).sort()) {
      if (runIds && !runIds.some((id) => f.startsWith(id))) continue;
      for (const line of readFileSync(join(base, d, f), 'utf8').split('\n')) {
        if (line) { try { rows.push(JSON.parse(line)); } catch { /* skip */ } }
      }
    }
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const val = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const dir = val('dir') ?? cacheDir(process.env);
  const s = summarize(latestPerFile(readLogs(dir, { runIds: val('run')?.split(','), days: Number(val('days') ?? 1) })));
  if (args.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else {
    console.log(`files ${s.files}; subprocess/git files ${s.subprocessFiles}`);
    console.log(`  traced ${s.traced} (${pct(s.traced, s.subprocessFiles)}%): clean ${s.tracedClean}, denied ${s.tracedDenied}`);
    console.log(`  clean share of subprocess/git files: ${s.cleanShareOfSubprocessPct}%`);
    console.log(`  denied by reason: ${JSON.stringify(s.deniedByReason)}`);
    console.log(`  tier B (static): ${JSON.stringify(s.tierB)}`);
    console.log(`  hit rate tier A (no trace needed): ${JSON.stringify(s.tierA)}`);
    console.log(`  hit rate tier B (trace needed):   ${JSON.stringify(s.tierBHit)}`);
  }
}
