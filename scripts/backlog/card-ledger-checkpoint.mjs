#!/usr/bin/env node
/** Print a reviewed checkpoint candidate; never edits the trust root or pushes. Signed mode only. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readCardLedger, sizedCardLedgerRun, cardLedgerPath } from '../lib/card-number-ledger.mjs';
import { resolveCardNumbering } from '../lib/policy-cascade.mjs';
export function cardLedgerCheckpoint({ repo = 'we', board = process.cwd(), commit, env = process.env, run = sizedCardLedgerRun(), ...options } = {}) {
  if (resolveCardNumbering({ env }).value.ledgerAuth !== 'signed') throw new Error('checkpoint requires ledgerAuth=signed');
  if (!/^[a-f0-9]{40}$/.test(commit || '') || commit.length !== 40) throw new Error('checkpoint requires full lowercase commit sha');
  const text = run(['show', `${commit}:${cardLedgerPath(repo)}`], { cwd: board });
  const ledger = readCardLedger({ ...options, repo, board, env, run, ledgerAuth: 'signed', existing: text, tip: commit });
  if (!ledger.readable) throw new Error(`checkpoint refused: ${ledger.errors.join('; ')}; review quarantine or increase historyBudget explicitly`);
  return { commit, fileSha256: createHash('sha256').update(text).digest('hex'),
    quarantinedLines: ledger.quarantinedLines,
    quarantinedCommits: [...new Set([...ledger.quarantinedCommits, ...ledger.trust.quarantine.map(q => q.commit)])] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(cardLedgerCheckpoint({ commit: process.argv[2], repo: process.argv.find(a => a.startsWith('--repo='))?.slice(7) || 'we' }), null, 2)); }
  catch (e) { console.error(String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000)); process.exitCode = 1; }
}
