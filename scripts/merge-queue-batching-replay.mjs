#!/usr/bin/env node
/** Offline/read-only comparison of measured merge_group CI and batching projections. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { replayBatching, resolveBatchingSettings } from './lib/merge-queue-adaptive-batching.mjs';

/** Injectable CLI entry point; fetching live data never mutates GitHub. */
export function main({ argv = process.argv.slice(2), exec = execFileSync, readFile = readFileSync, print = console.log, settings = resolveBatchingSettings() } = {}) {
  const flags = Object.fromEntries(argv.filter(a => a.startsWith('--')).map(a => {
    const i = a.indexOf('=');
    return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
  if (flags.help) {
    print('Usage: node scripts/merge-queue-batching-replay.mjs [--runs-file=path | --repo=owner/name] [--since=ISO] [--workflow=CI] [--ci-minutes=N] [--json]');
    return;
  }
  const allowed = ['runs-file', 'repo', 'since', 'workflow', 'ci-minutes', 'json'];
  for (const key of Object.keys(flags)) if (!allowed.includes(key)) throw new Error(`unknown option --${key}`);
  const fields = 'databaseId,name,conclusion,status,createdAt,updatedAt,headBranch';
  const raw = flags['runs-file'] ? readFile(flags['runs-file'], 'utf8') : exec('gh', ['run', 'list', ...(flags.repo ? ['--repo', flags.repo] : []), '--event', 'merge_group', '-L', '1000', '--json', fields], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const input = JSON.parse(raw);
  if (!Array.isArray(input)) throw new Error('runs input must be a JSON array');
  const since = flags.since ? Date.parse(flags.since) : -Infinity;
  if (flags.since && !Number.isFinite(since)) throw new Error('--since must be an ISO date');
  const runs = input.filter(r => r.name === (flags.workflow ?? 'CI') && Date.parse(r.createdAt) >= since);
  const results = ['ALLGREEN', 'HEADGREEN'].map(policy => replayBatching({ runs, settings, policy, ciMinutes: flags['ci-minutes'] === undefined ? undefined : Number(flags['ci-minutes']) }));
  const report = { workflow: flags.workflow ?? 'CI', since: flags.since ?? null, settings, ciMinutes: results[0].ciMinutes, baseline: results[0].baseline, projected: Object.fromEntries(results.map(r => [r.policy, r.projected])), failures: Object.fromEntries(results.map(r => [r.policy, r.failures])) };
  if (flags.json) { print(JSON.stringify(report, null, 2)); return report; }
  const rows = [
    ['full runs', 'fullRuns'], ['runs/merged PR', 'runsPerMergedPr'], ['merged PRs', 'mergedPrs'],
    ['created-but-cancelled', 'createdCancelled'], ['isolation runs', 'isolationRuns'], ['strict-mode episodes', 'strictModeEpisodes'], ['failures', 'failures'],
  ];
  print(`CI duration: ${report.ciMinutes.toFixed(2)} minutes; measured obsolete overlapping runs: ${report.baseline.obsoleteOverlapping}`);
  print(`${'metric'.padEnd(24)} ${'baseline'.padStart(10)} ${'ALLGREEN'.padStart(10)} ${'HEADGREEN'.padStart(10)}`);
  for (const [label, key] of rows) {
    const values = [report.baseline, report.projected.ALLGREEN, report.projected.HEADGREEN].map(m => (key === 'runsPerMergedPr' ? m[key].toFixed(2) : String(m[key])).padStart(10));
    print(`${label.padEnd(24)} ${values.join(' ')}`);
  }
  const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
  for (const r of results) for (const f of r.failures) print(`${r.policy}: #${f.num} ref ${f.ref} at ${et.format(f.atMs)} ET → group ${f.members.map(n => `#${n}`).join(',')} → ${f.isolated ? 'isolated' : 'single PR'} → culprit #${f.culprit}`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { process.stderr.write(`merge-queue replay: ${e.message}\n`); process.exitCode = 1; }
}
