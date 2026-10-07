#!/usr/bin/env node
/** Daemon-owned prepare completion. All mutations run in an acquired lane through the normal PR producer. */
import { retryTransientGit } from '../lib/git-fetch-retry.mjs';
import { machinePrTitle } from './machine-pr-title.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCardStatus } from '../conveyor/prepare-result.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { releaseHoldRoute, isValidHoldNum } from '../conveyor/build-dispatch-hold-router.mjs';
import { acquireLane, releaseLane, runCmd, parseOpenPrResult } from './build-dispatch-hold-route-land.mjs';

export async function landPrepareStamp({ num }, {
  run = runCmd, acquire = acquireLane, release = releaseLane,
  read = readFileSync, write = writeFileSync,
  readStatus = async (args) => (await import('../../skills-src/conveyor/build-dispatch-daemon.mjs')).cliReadPrepareStatus(args),
} = {}) {
  if (!isValidHoldNum(num)) throw new Error('invalid prepare item number');
  let lane;
  try {
    const status = await readStatus({ num });
    if (status.preparedDate || status.pr?.preparedDate) return { status: 'already-stamped' };
    const source = status.pr?.state === 'OPEN' && status.pr.hasSections ? status.pr : null;
    if (!source && !status.hasSections) throw new Error('prepare-unstamped: missing sections');
    lane = acquire(run);
    const cwd = lane.path;
    if (!cwd) throw new Error('lane acquisition returned no path');
    // Preserve the original PR's entire tree when repairing its head; otherwise start from fresh main.
    const path = status.path;
    if (!new RegExp(`^backlog/${num}-[^/]+\\.md$`).test(path ?? '')) throw new Error('invalid prepare card path');
    retryTransientGit(() => run('git', ['fetch', 'origin', 'main'], cwd));
    retryTransientGit(() => run('git', ['fetch', 'origin', source ? source.headRefName : 'main'], cwd));
    if (source && run('git', ['rev-parse', 'FETCH_HEAD'], cwd).trim() !== source.headRefOid) {
      throw new Error('prepare PR changed during recovery; retry observation');
    }
    // Trust boundary: the daemon runs this tree's scripts with its own credentials, so a PR head may change only its card.
    if (source) {
      const changed = run('git', ['diff', '--name-only', 'origin/main...FETCH_HEAD'], cwd).split('\n').map((f) => f.trim()).filter(Boolean);
      if (changed.some((f) => f !== path)) throw new Error('prepare-unstamped: PR changes files beyond the card');
    }
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], cwd);
    const before = read(join(cwd, path), 'utf8');
    const card = prepareCardStatus(before);
    if (card.preparedDate) return { status: 'already-stamped' };
    if (!card.hasSections || readField(before, 'status') !== 'open') {
      throw new Error('prepare-unstamped: lane card is not open with all required sections');
    }
    run('node', [join(cwd, 'scripts/backlog.mjs'), 'prepare-stamp', String(num)], cwd);
    if (!prepareCardStatus(read(join(cwd, path), 'utf8')).preparedDate) throw new Error('prepare-stamp did not stamp card');
    run('git', ['add', '--', path], cwd);
    run('git', ['commit', '-m', machinePrTitle({ item: num, kind: 'prepare-stamp', card: { title: /^#\s+(.+)$/m.exec(before)?.[1] } }), '--', path], cwd);
    if (!prepareCardStatus(run('git', ['show', `HEAD:${path}`], cwd)).preparedDate) throw new Error('stamp absent from HEAD');
    run('node', [join(cwd, 'scripts/operations/run.mjs'), 'verify', `--checkout=${cwd}`], cwd, { timeoutMs: 30 * 60_000 });
    const bodyFile = join(cwd, '.git', 'prepare-stamp-body.md');
    write(bodyFile, `Complete the sanctioned preparation stamp for #${num}. Design, MVP, Test plan and Proof plan are present.\n`);
    const out = run('node', [join(cwd, 'scripts/operations/run.mjs'), 'open-pr',
      `--ref=${source?.headRefName ?? `lane/${num}-prepare-stamp`}`, '--sha=HEAD', '--base=main',
      `--bodyFile=${bodyFile}`, '--mode=label-on-green', '--json'], cwd, { timeoutMs: 10 * 60_000 });
    const pr = parseOpenPrResult(out);
    if (!pr.pr) throw new Error('prepare stamp PR was not confirmed');
    return { status: 'submitted', ...pr };
  } finally {
    if (lane) release(lane, run);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const num = process.argv.slice(2).find((a) => a.startsWith('--num='))?.slice(6);
  landPrepareStamp({ num }).then((result) => {
    // Success (or nothing left to stamp) frees the route so a later re-unstamped card can be recovered again.
    releaseHoldRoute({ num, route: 'prepare-stamp' });
    console.log(JSON.stringify(result));
  }).catch((error) => {
    // The daemon reads this terminal record before considering another recovery. Time is not a fix.
    console.log(JSON.stringify({ status: 'failed', attempt: `stamp:${num}:${new Date().toISOString()}`, error: String(error?.message || error) }));
    console.error(String(error?.stack || error));
    process.exitCode = 1;
  });
}
