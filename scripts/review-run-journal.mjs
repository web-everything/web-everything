#!/usr/bin/env node
/**
 * Seed the shared review-run discovery journal or measure a head-scoped evidence lookup.
 * Usage: review-run-journal.mjs seed [--runs-dir=<dir>]
 *        review-run-journal.mjs --probe <repo>#<pr> [--head=<40hex>] [--runs-dir=<dir>]
 * Journal failures use the existing bounded scan; its cap is unchanged.
 */
import { resolveRunsDir, listRunIds, readRun } from './operations/run-store.mjs';
import { readJournalCandidates, seedReviewRunJournal } from './lib/review-run-index.mjs';
import { readDrainRedTeamEvidence } from './lib/drain-red-team-evidence.mjs';

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  const runsDir = option('runs-dir') ?? resolveRunsDir();
  if (args[0] === 'seed') {
    const counts = seedReviewRunJournal({ runsDir });
    for (const name of ['seeded', 'already', 'skipped']) console.log(`${name}: ${counts[name]}`);
  } else if (args[0] === '--probe') {
    const match = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(args[1] ?? '');
    const head = option('head') ?? '0'.repeat(40);
    if (!match || !Number.isSafeInteger(Number(match[2])) || !/^[a-f0-9]{40}$/i.test(head)) throw Error('invalid probe key or head');
    const [, repo, pr] = match;
    const journal = readJournalCandidates(runsDir, repo, pr, { list: listRunIds });
    let parses = 0;
    readDrainRedTeamEvidence({ repo, pr: Number(pr), head, runsDir,
      read: (id, dir) => { parses++; return readRun(id, dir); }, readScorecards: () => [] });
    console.log(`source: ${journal === null ? 'scan' : 'journal'}`);
    console.log(`parses: ${parses}`);
    console.log(`candidates: ${journal?.ids.length ?? listRunIds(runsDir).filter(id => id.startsWith('review-pr-')).length}`);
    console.log(`unjournaled: ${journal?.unjournaled ?? listRunIds(runsDir).filter(id => id.startsWith('review-pr-')).length}`);
  } else throw Error('usage: review-run-journal.mjs seed | --probe <repo>#<pr> [--head=<40hex>] [--runs-dir=<dir>]');
} catch (error) {
  console.error(error.message.replace(/[\x00-\x1f\x7f]/g, ' '));
  process.exitCode = 1;
}
