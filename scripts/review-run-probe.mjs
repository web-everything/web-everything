#!/usr/bin/env node
/** Measure filename discovery without changing run evidence.
 * Usage: review-run-probe.mjs --probe <repo>#<pr> [--head=<40hex>] [--runs-dir=<dir>]
 */
import { resolveRunsDir, readRun, NAME_RE } from './operations/run-store.mjs';
import { readNamedCandidates } from './lib/review-run-index.mjs';
import { readDrainRedTeamEvidence } from './lib/drain-red-team-evidence.mjs';

const args = process.argv.slice(2);
const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
try {
  const match = /^([\w.-]+\/[\w.-]+)#([1-9][0-9]*)$/.exec(args[1] ?? '');
  const head = option('head') ?? '0'.repeat(40);
  if (args[0] !== '--probe' || !match || !Number.isSafeInteger(Number(match[2])) || !/^[a-f0-9]{40}$/i.test(head)) {
    throw Error('usage: review-run-probe.mjs --probe <repo>#<pr> [--head=<40hex>] [--runs-dir=<dir>]');
  }
  const [, repo, pr] = match;
  const runsDir = option('runs-dir') ?? resolveRunsDir();
  const names = readNamedCandidates(runsDir, repo, pr);
  let parses = 0;
  const mismatches = new Set();
  try {
    readDrainRedTeamEvidence({ repo, pr: Number(pr), head, runsDir,
      read: (id, dir) => {
        parses++;
        const run = readRun(id, dir), keyed = NAME_RE.exec(id);
        if (run.id !== id || (keyed && (run.op !== 'review-pr' || Number(run.input?.pr) !== Number(keyed[1])))) mismatches.add(id);
        return run;
      }, readScorecards: () => [] });
  } catch { /* Metrics still report a refused/unreadable lookup. */ }
  console.log(`source: ${names === null ? 'scan' : 'names'}`);
  console.log(`parses: ${parses}`);
  console.log(`legacy: ${names?.legacy ?? 'unknown'}`);
  console.log(`mismatch: ${mismatches.size}`);
} catch (error) {
  console.error(error.message.replace(/[\x00-\x1f\x7f]/g, ' '));
  process.exitCode = 1;
}
