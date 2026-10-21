/**
 * @file lane-pool-git-diet.test.mjs — lane-pool applies the lane git diet (../lib/lane-git-diet.mjs) on the real
 *   CLI paths: a freshly provisioned lane carries the `^refs/heads/ops/*` refspec + unpackLimit=1 and no
 *   `origin/ops/*`; an existing lane without the diet gets it on its next acquire fetch, which then skips the
 *   advanced ops tip; an explicit by-name reader fetch still works.
 */
import { it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

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
  } finally { rmSync(base, { recursive: true, force: true }); }
}, 60000);
