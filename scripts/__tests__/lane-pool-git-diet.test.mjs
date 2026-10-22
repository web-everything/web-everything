/**
 * @file lane-pool-git-diet.test.mjs — lane-pool applies the lane git diet (../lib/lane-git-diet.mjs) on the real
 *   CLI paths: a freshly provisioned lane carries the `^refs/heads/ops/*` refspec + unpackLimit=1 and no
 *   `origin/ops/*`; an existing lane without the diet gets it on its next acquire fetch, which then skips the
 *   advanced ops tip; an explicit by-name reader fetch still works.
 */
import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Read-only proof tests can run even where the launcher forbids Git metadata writes.
const proofSource = /function localRemoteShas\([^]*?\n\}/.exec(readFileSync(resolve('scripts/lane-pool.mjs'), 'utf8'))[0];
const defaultFetch = '+refs/heads/*:refs/remotes/origin/*';
const excludedOps = '^refs/heads/ops/*';
const customFetchCases = [
  ['exact ops remap', [defaultFetch, excludedOps, '+refs/heads/ops/review-requests:refs/remotes/origin/saved']],
  ['wildcard ops remap', [defaultFetch, excludedOps, '+refs/heads/ops/*:refs/remotes/origin/archive/*']],
  ['additional exclusion', [defaultFetch, excludedOps, '^refs/heads/saved']],
  ['restricted positive mapping', ['+refs/heads/trunk:refs/remotes/origin/trunk', excludedOps]],
  ['tag remap', [defaultFetch, excludedOps, '+refs/tags/*:refs/remotes/origin/tags/*']],
  ['missing config', null],
  ['empty config', []],
];
it.each(customFetchCases)('local remote proof rejects %s', (_name, fetchValues) => {
  const tryGit = (args) => args[0] === 'config'
    ? fetchValues?.join('\n') ?? null
    : 'unique refs/remotes/origin/saved \nunique refs/remotes/origin/archive/review-requests ';
  const localRemoteShas = new Function('tryGit', `${proofSource}; return localRemoteShas;`)(tryGit);
  expect([...localRemoteShas('/unused')]).toEqual([]);
});
it.each([[defaultFetch], [defaultFetch, excludedOps], [defaultFetch, excludedOps, defaultFetch]])(
  'local remote proof retains standard direct refs and excludes symbolic and ops refs (%j)', (...fetchValues) => {
  const tryGit = (args) => args[0] === 'config'
    ? fetchValues.join('\n')
    : 'fresh refs/remotes/origin/trunk \nstale refs/remotes/origin/ops/review-requests \nstale refs/remotes/origin/saved refs/remotes/origin/ops/review-requests';
  const localRemoteShas = new Function('tryGit', `${proofSource}; return localRemoteShas;`)(tryGit);
  expect([...localRemoteShas('/unused')]).toEqual(['fresh']);
});

it('provision + acquire keep ops/* out of a lane while explicit reader fetches still work', () => {
  const base = mkdtempSync(join(tmpdir(), 'pool-git-diet-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const opsRefs = (cwd) => git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/ops/'], cwd);
  try {
    const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
    git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
    git(['clone', '--quiet', origin, reference]);
    git(['config', 'user.email', 'test@example.com'], reference);
    git(['config', 'user.name', 'Test'], reference);
    writeFileSync(join(reference, 'file.txt'), 'seed');
    git(['add', '.'], reference);
    git(['commit', '--quiet', '-m', 'seed'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/trunk', 'HEAD:refs/heads/ops/review-requests'], reference);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=diet', '--branch=trunk', '--no-install'];
    const run = (extra) => spawnSync('node', [resolve('scripts/lane-pool.mjs'), ...extra, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool } });

    const provision = run(['provision', '--count=1']);
    expect(provision.status, provision.stderr).toBe(0);
    const lane = join(pool, 'diet', 'lane-1');
    expect(git(['config', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(git(['config', '--get', 'transfer.unpackLimit'], lane)).toBe('1');
    expect(opsRefs(lane)).toBe('');

    // An OLD lane (pre-diet config) re-gains the diet on its next acquire fetch.
    git(['config', '--unset', 'remote.origin.fetch', '\\^refs/heads/ops/\\*'], lane);
    git(['config', '--unset', 'fetch.unpackLimit'], lane);
    writeFileSync(join(reference, 'ledger.jsonl'), 'row\n');
    git(['add', '.'], reference);
    git(['commit', '--quiet', '-m', 'ledger'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/ops/review-requests'], reference);
    const acquire = run(['acquire', '--lane=1', '--session=diet-test']);
    expect(acquire.status, acquire.stderr).toBe(0);
    expect(git(['config', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(opsRefs(lane)).toBe('');

    // A reader that fetches by name still gets the current tip.
    git(['fetch', '--quiet', 'origin', '+refs/heads/ops/review-requests:refs/remotes/origin/ops/review-requests'], lane);
    expect(git(['rev-parse', 'origin/ops/review-requests'], lane)).toBe(git(['rev-parse', 'HEAD'], reference));
    run(['release', '--lane=1', '--session=diet-test']);

    // Scrubbing an include invalidates the earlier config snapshot: the included diet settings disappear.
    git(['config', '--unset', 'remote.origin.fetch', '\\^refs/heads/ops/\\*'], lane);
    git(['config', '--unset', 'fetch.unpackLimit'], lane);
    git(['config', '--unset', 'transfer.unpackLimit'], lane);
    const included = join(base, 'included.config');
    writeFileSync(included, '[remote "origin"]\nfetch = ^refs/heads/ops/*\n[fetch]\nunpackLimit = 1\n[transfer]\nunpackLimit = 1\n');
    git(['config', 'include.path', included], lane);
    const reacquire = run(['acquire', '--lane=1', '--session=diet-test']);
    expect(reacquire.status, reacquire.stderr).toBe(0);
    expect(git(['config', '--local', '--get-all', 'remote.origin.fetch'], lane).split('\n')).toContain('^refs/heads/ops/*');
    expect(git(['config', '--local', '--get', 'fetch.unpackLimit'], lane)).toBe('1');
    expect(git(['config', '--local', '--get', 'transfer.unpackLimit'], lane)).toBe('1');
    run(['release', '--lane=1', '--session=diet-test']);
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60000);

// Exercise both localRemoteShas callers: explicit acquire's pre-fetch check and auto-pick's
// post-fetch re-verification. The latter must distrust even an ops ref that proved containment
// at pick time, because the default fetch cannot refresh or prune it.
const staleOpsCases = ['explicit', 'auto'].flatMap((mode) =>
  ['exact tip', 'ancestor'].flatMap((containment) =>
    ['deleted', 'moved'].flatMap((change) =>
      ['none', 'direct', 'chained', 'HEAD', 'external', 'mapped', 'wildcard-mapped'].map((alias) => ({ mode, containment, change, alias })))));

it.each(staleOpsCases)('$mode acquire protects $containment work when its only ops proof was $change (alias: $alias)', ({ mode, containment, change, alias }) => {
  withContainmentLane(({ base, origin, reference, lane, git, run }) => {
    const head = git(['rev-parse', 'HEAD'], lane);
    const content = readFileSync(join(lane, 'file.txt'), 'utf8');
    const ops = 'refs/heads/ops/review-requests';
    git(['fetch', '--quiet', lane, 'HEAD'], reference);
    if (containment === 'ancestor') {
      git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], reference);
      writeFileSync(join(reference, 'ledger.jsonl'), 'later ledger entry\n');
      git(['add', 'ledger.jsonl'], reference);
      git(['commit', '--quiet', '-m', 'containing ops tip'], reference);
    }
    git(['push', '--quiet', origin, `${containment === 'ancestor' ? 'HEAD' : 'FETCH_HEAD'}:${ops}`], reference);
    git(['fetch', '--quiet', 'origin', `+${ops}:refs/remotes/origin/ops/review-requests`], lane);
    const staleTip = git(['rev-parse', 'origin/ops/review-requests'], lane);
    expect(staleTip === head).toBe(containment === 'exact tip');
    expect(git(['merge-base', '--is-ancestor', head, staleTip], lane)).toBe('');
    expect(git(['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/origin/'], lane))
      .toBe('refs/remotes/origin/ops/review-requests');

    // Symbolic refs have their own innocent-looking names, but resolve to tips the default
    // fetch does not refresh. Include multi-hop aliases and targets outside origin entirely.
    const opsTracking = 'refs/remotes/origin/ops/review-requests';
    if (alias === 'direct' || alias === 'chained') {
      git(['symbolic-ref', 'refs/remotes/origin/saved', opsTracking], lane);
      if (alias === 'chained') git(['symbolic-ref', 'refs/remotes/origin/backup', 'refs/remotes/origin/saved'], lane);
    } else if (alias === 'HEAD') {
      git(['symbolic-ref', 'refs/remotes/origin/HEAD', opsTracking], lane);
    } else if (alias === 'external') {
      git(['update-ref', 'refs/saved/proof', staleTip], lane);
      git(['symbolic-ref', 'refs/remotes/origin/saved', 'refs/saved/proof'], lane);
    } else if (alias === 'mapped' || alias === 'wildcard-mapped') {
      const mapping = alias === 'mapped'
        ? `+${ops}:refs/remotes/origin/saved`
        : '+refs/heads/ops/*:refs/remotes/origin/archive/*';
      git(['config', '--add', 'remote.origin.fetch', mapping], lane);
      git(['fetch', '--quiet', 'origin', mapping], lane);
    }

    const mutation = change === 'deleted'
      ? ['update-ref', '-d', ops]
      : ['update-ref', ops, 'refs/heads/trunk'];
    // Explicit acquire checks local refs before fetching. Auto-pick first sees a genuinely live
    // remote proof; mutate origin at the fetch boundary to make that proof stale deterministically.
    if (mode === 'explicit') git(mutation, origin);
    const bin = join(base, 'bin'), trace = join(base, 'git-trace.jsonl');
    mkdirSync(bin);
    writeFileSync(trace, '');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'auto' && args[0] === 'fetch') {
  const changed = spawnSync(${JSON.stringify(realGit)}, ${JSON.stringify(mutation)}, { cwd: ${JSON.stringify(origin)}, stdio: 'inherit' });
  if (changed.status !== 0) process.exit(changed.status ?? 1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o755);

    const acquire = run(['acquire', ...(mode === 'explicit' ? ['--lane=1'] : []), '--session=stale-ops', '--hard-max=1'], { PATH: `${bin}:${process.env.PATH}` });
    expect(acquire.status, acquire.stderr).not.toBe(0);
    expect(acquire.stderr).toMatch(mode === 'explicit' ? /would destroy that work/ : /no longer provably safe to reset/);
    const calls = readFileSync(trace, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    if (mode === 'auto') expect(calls.some((args) => args[0] === 'fetch' && args.includes('--prune'))).toBe(true);
    expect(calls.some((args) => (args[0] === 'checkout' && args.includes('-B')) || args[0] === 'clean')).toBe(false);
    expect(git(['rev-parse', 'origin/ops/review-requests'], lane)).toBe(staleTip);
    expect(git(['for-each-ref', '--contains=' + head, '--format=%(refname)', 'refs/heads/'], origin)).toBe('');
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(head);
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe(content);
    expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
  });
}, 60000);

it.each(['explicit', 'auto'])('%s acquire can still reset work contained by a fresh non-ops ref', (mode) => {
  withContainmentLane(({ origin, lane, git, run }) => {
    git(['push', '--quiet', origin, 'HEAD:refs/heads/lane/landed'], lane);
    git(['fetch', '--quiet', 'origin'], lane);
    const acquire = run(['acquire', ...(mode === 'explicit' ? ['--lane=1'] : []), '--session=fresh-proof', '--hard-max=1']);
    expect(acquire.status, acquire.stderr).toBe(0);
    expect(acquire.stdout.trim()).toBe(lane);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(git(['rev-parse', 'refs/heads/trunk'], origin));
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('seed\n');
  });
}, 60000);

function withContainmentLane(check) {
  const base = mkdtempSync(join(tmpdir(), 'pool-ops-containment-'));
  const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    const origin = join(base, 'origin.git'), reference = join(base, 'reference'), pool = join(base, 'pool');
    git(['init', '--quiet', '--bare', '--initial-branch=trunk', origin]);
    git(['clone', '--quiet', origin, reference]);
    git(['config', 'user.email', 'test@example.com'], reference);
    git(['config', 'user.name', 'Test'], reference);
    writeFileSync(join(reference, 'file.txt'), 'seed\n');
    git(['add', 'file.txt'], reference);
    git(['commit', '--quiet', '-m', 'seed'], reference);
    git(['push', '--quiet', origin, 'HEAD:refs/heads/trunk'], reference);
    const args = [`--origin=${origin}`, `--reference=${reference}`, '--name=containment', '--branch=trunk', '--no-install'];
    const run = (extra, env = {}) => spawnSync('node', [resolve('scripts/lane-pool.mjs'), ...extra, ...args], {
      encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: pool, ...env }, timeout: 30000,
    });
    const provision = run(['provision', '--count=1']);
    expect(provision.status, provision.stderr).toBe(0);
    const lane = join(pool, 'containment', 'lane-1');
    git(['config', 'user.email', 'test@example.com'], lane);
    git(['config', 'user.name', 'Test'], lane);
    writeFileSync(join(lane, 'file.txt'), 'irreplaceable lane work\n');
    git(['add', 'file.txt'], lane);
    git(['commit', '--quiet', '-m', 'unique lane work'], lane);
    expect(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane)).toBe('1');
    check({ base, origin, reference, lane, git, run });
  } finally { rmSync(base, { recursive: true, force: true }); }
}
