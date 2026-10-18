#!/usr/bin/env node
/** One-time open-PR baseline import. --dry-run reads GitHub and the selected ledger without writing. */
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendVerdict, observedLedgerHead, readLedgerEventsFromStore } from '../lib/verdict-ledger.mjs';
import { drainLedgerReadStore } from '../lib/drain-ledger-facts.mjs';
import { planLedgerObservation, resolveLedgerObservationSettings, logLedgerObservationSettings } from '../lib/ledger-observation.mjs';

export async function backfillLedger({ repo, prs, events, dryRun = false, append = appendVerdict,
  settings = resolveLedgerObservationSettings(), now = new Date().toISOString() } = {}) {
  if (!Array.isArray(events)) throw Error('backfill refuses an unreadable ledger');
  const result = { repo, dryRun, open: prs.length, missing: 0, planned: 0, written: 0 };
  for (const pr of prs) {
    const number = pr.number;
    // Already baselined means a witnessed head, not merely a row: a headless drain park is not a baseline.
    const mine = events.filter(e => e.repo.toLowerCase() === repo.toLowerCase() && e.pr === number);
    if (mine.length && observedLedgerHead(mine)) continue;
    result.missing++;
    const rows = planLedgerObservation({ repo, pr: number, headSha: pr.headRefOid ?? pr.head?.sha,
      labels: (pr.labels ?? []).map(l => typeof l === 'string' ? l : l.name), state: pr.state ?? 'OPEN', events, settings, now });
    result.planned += rows.length;
    if (!dryRun) for (const row of rows) {
      const receipt = append(row);
      if (!receipt?.ok || receipt.ledgerWriteMiss) throw Error(`backfill append failed for ${repo}#${number}`);
      events = [...events, row];
      if (!receipt.duplicate) result.written++;
    }
  }
  return result;
}

export async function main(argv = process.argv.slice(2), { exec = execFileSync,
  readLedger = repo => readLedgerEventsFromStore(repo, { store: drainLedgerReadStore(repo) }), append = appendVerdict,
  settings = resolveLedgerObservationSettings(), out = s => process.stdout.write(s), log } = {}) {
  if (argv.some(a => a !== '--dry-run' && !a.startsWith('--repo='))) throw Error('usage: ledger-backfill.mjs [--dry-run] [--repo=owner/name]');
  const gh = args => JSON.parse(String(exec('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })));
  const repo = argv.find(a => a.startsWith('--repo='))?.slice(7) || gh(['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  // The slug becomes an API path: a dot-only segment would traverse it.
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(s => /^\.+$/.test(s))) throw Error('invalid repository');
  const pages = gh(['api', `repos/${repo}/pulls?state=open&per_page=100`, '--paginate', '--slurp']);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw Error('expected --slurp output to be an array of pages');
  const prs = pages.flat();
  const ledger = await readLedger(repo);
  if (ledger?.status !== 'ok') throw Error(`ledger unreadable: ${ledger?.reason}`);
  logLedgerObservationSettings(settings, log);
  const result = await backfillLedger({ repo, prs, events: ledger.rows, dryRun: argv.includes('--dry-run'), append, settings });
  out(`${JSON.stringify(result)}\n`);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });
}
