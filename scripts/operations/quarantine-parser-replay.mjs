#!/usr/bin/env node
/**
 * @file scripts/operations/quarantine-parser-replay.mjs
 * @description READ-ONLY replay of the red-main quarantine parser over the logs of recent failing main jobs.
 *   Lists the last N failing main runs, fetches each failed job's log, feeds it to `parseVitestFailures` and
 *   prints one JSON line per job, then first-veto counts grouped by family
 *   (console, setup, teardown, system, head, count, step, other). Nothing is written to GitHub or the repo.
 *
 *   Stop condition (prep Amendment 5): console is the largest family AND more than 50% of incomplete jobs.
 *
 * Usage: node scripts/operations/quarantine-parser-replay.mjs [--runs=30] [--repo=owner/name] [--cache=<dir>]
 *   --cache stores fetched logs as <dir>/<jobId>.log so a second run (after the parser fix) reuses the same logs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ciJobLogApiArgs } from '../lib/gh-ci-log.mjs';
import { parseVitestFailures } from '../lib/red-main-quarantine.mjs';

const arg = (name, dflt) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 90_000 });

/** First-veto family. PURE. `veto` is `{line, reason, text?}`. */
export function vetoFamily(veto) {
  const r = String(veto?.reason ?? '');
  if (!r) return 'none';
  if (/console/.test(r)) return 'console';
  if (/step-boundary/.test(r)) return 'step';
  if (/teardown/i.test(`${r} ${veto.text ?? ''}`)) return 'teardown';
  if (/system|signal|exit code/i.test(r)) return 'system';
  if (/head|FAIL header/.test(r)) return 'head';
  if (/summary|header count|inconsistent|duplicate/.test(r)) return 'count';
  if (/setup|unclaimed trouble/.test(r)) return 'setup';
  return 'other';
}

function main() {
  const runs = Number(arg('runs', '30'));
  const repo = arg('repo', 'chalbert/web-everything');
  const cache = arg('cache', '');
  if (cache) mkdirSync(cache, { recursive: true });
  const list = JSON.parse(gh(['run', 'list', '--repo', repo, '--branch', 'main', '--status', 'failure', '--limit', String(runs), '--json', 'databaseId']));
  const counts = {};
  let incomplete = 0, complete = 0;
  for (const { databaseId } of list) {
    let jobs = [];
    try {
      const raw = gh(['api', `repos/${repo}/actions/runs/${databaseId}/jobs`, '--paginate', '--jq', '.jobs[] | select(.conclusion=="failure") | {id, name}']);
      jobs = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
    } catch { console.log(JSON.stringify({ run: databaseId, error: 'jobs-fetch-failed' })); continue; }
    for (const job of jobs) {
      let text = '';
      const file = cache ? join(cache, `${job.id}.log`) : '';
      try {
        if (file && existsSync(file)) text = readFileSync(file, 'utf8');
        else {
          text = gh(ciJobLogApiArgs(`repos/${repo}/actions/jobs/${job.id}/logs`));
          if (file) writeFileSync(file, text);
        }
      } catch { console.log(JSON.stringify({ run: databaseId, job: job.name, jobId: job.id, error: 'log-fetch-failed' })); continue; }
      const parsed = parseVitestFailures(text);
      const first = parsed.vetoes[0];
      const family = parsed.complete ? 'complete' : vetoFamily(first);
      if (parsed.complete) complete++; else { incomplete++; counts[family] = (counts[family] ?? 0) + 1; }
      console.log(JSON.stringify({ run: databaseId, job: job.name, jobId: job.id, complete: parsed.complete, blocks: parsed.tests.length, timeouts: parsed.timeouts.length, family, firstVeto: first ?? null }));
    }
  }
  const largest = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const stop = Boolean(largest && largest[0] === 'console' && largest[1] / incomplete > 0.5);
  console.log(JSON.stringify({ summary: { complete, incomplete, families: counts, stopConsoleDominates: stop } }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
