import { describe, it, expect } from 'vitest';
import { mkdirSync, renameSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withBareOrigin } from './helpers/real-repo.mjs';
import { assertRunnerFreshness } from '../runner-freshness.mjs';

const live = { session: 'holder', acquiredAt: new Date().toISOString(), ttlMinutes: 240 };
const sha = 'a'.repeat(40);
function run({ lease = { ...live, at: sha, branch: 'lane/target' }, head = sha, tip = sha, unreadable = false, fetchFails = false, attached = false, symbolic = false, symbolicUnreadable = false, headUnreadable = false, env = {} } = {}) {
  const calls = [];
  const check = () => assertRunnerFreshness({ declaration: { name: 'open-pr' }, moduleUrl: 'file:///pool/repo/lane-1/scripts/operations/run.mjs' }, {
    env: { LANE_POOL_ROOT: '/pool', ...env },
    filesystem: {
      realpathSync: p => p,
      readFileSync: () => { if (unreadable) throw new Error('unreadable lease'); return JSON.stringify(lease); },
    },
    git: args => {
      calls.push(args);
      if (args.includes('--show-toplevel')) return '/pool/repo/lane-1';
      if (args[0] === 'symbolic-ref') {
        if (args.includes('HEAD') && attached) return 'lane/target';
        if (!args.includes('HEAD') && symbolic) return 'refs/remotes/origin/other';
        throw Object.assign(new Error('not symbolic'), { status: (symbolicUnreadable && !args.includes('HEAD')) || (headUnreadable && args.includes('HEAD')) ? 128 : 1 });
      }
      if (args.includes('--git-path')) return '.git/.lane-lease';
      if (args[0] === 'fetch') { if (fetchFails) throw new Error('unreadable origin'); return ''; }
      if (args.includes('HEAD')) return head;
      if (args.includes('refs/remotes/origin/lane/target')) return tip;
      if (args[0] === 'check-ref-format') return '';
      throw new Error('unexpected git read: ' + args.join(' '));
    },
  });
  return { check, calls };
}
describe('open-pr pinned runner lease', () => {
  it('hardens the real pinned fetch and scrubs inherited repository locations', async () => {
    await withBareOrigin(async ctx => {
      ctx.git(['push', 'origin', 'HEAD:lane/target']);
      const pin = ctx.git(['rev-parse', 'HEAD']).trim();
      const pool = join(ctx.tmp, 'pool'), lane = join(pool, 'repo', 'lane-1');
      mkdirSync(join(pool, 'repo'), { recursive: true }); renameSync(ctx.clone, lane);
      const git = args => execFileSync('git', args, { cwd: lane, encoding: 'utf8' });
      git(['checkout', '--detach', '--quiet', pin]);
      writeFileSync(join(lane, '.git', '.lane-lease'), JSON.stringify({ ...live, at: pin, branch: 'lane/target' }));
      const hooks = join(ctx.tmp, 'hooks'), marker = join(ctx.tmp, 'hook-ran'); mkdirSync(hooks);
      writeFileSync(join(hooks, 'reference-transaction'), '#!/usr/bin/env node\n' +
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
      chmodSync(join(hooks, 'reference-transaction'), 0o755); git(['config', 'core.hooksPath', hooks]);
      git(['update-ref', '-d', 'refs/remotes/origin/lane/target']);
      // Deleting the ref exercises the fixture hook; only the production fetch must suppress it.
      if (existsSync(marker)) rmSync(marker);
      expect(assertRunnerFreshness({ declaration: { name: 'open-pr' }, moduleUrl: pathToFileURL(join(lane, 'run.mjs')).href }, {
        env: { ...process.env, LANE_POOL_ROOT: pool, GIT_DIR: '/missing', GIT_WORK_TREE: '/missing', GIT_INDEX_FILE: '/missing' },
      })).toEqual({ exempt: true });
      expect(existsSync(marker)).toBe(false);
      expect(git(['rev-parse', 'refs/remotes/origin/lane/target']).trim()).toBe(pin);
    });
  });
  it('accepts HEAD == lease at == freshly fetched branch tip even after main moves', () => {
    const f = run(); expect(f.check()).toMatchObject({ exempt: true });
    expect(f.calls).toContainEqual(['fetch', '--quiet', 'origin', '+refs/heads/lane/target:refs/remotes/origin/lane/target']);
  });
  it('refuses an attached HEAD carrying a valid pinned lease', () => expect(run({ attached: true }).check).toThrow(/attached/));
  it('refuses a symbolic tracking ref after fetch', () => expect(run({ symbolic: true }).check).toThrow(/symbolic/));
  it('refuses unreadable HEAD attachment evidence', () => expect(run({ headUnreadable: true }).check).toThrow());
  it('refuses unreadable tracking-ref evidence', () => expect(run({ symbolicUnreadable: true }).check).toThrow());
  it.each([null, { ...live, acquiredAt: 'invalid' }, { ...live, acquiredAt: new Date(0).toISOString() },
    { ...live, session: '' }, { ...live, ttlMinutes: -1 }, { ...live, renewedAt: 'bad' }, { ...live, reserved: true }])('refuses malformed or expired live evidence %j', evidence => {
    expect(run({ lease: evidence && { ...evidence, at: sha, branch: 'lane/target' } }).check).toThrow();
  });
  it('accepts an old lease renewed within its TTL', () => {
    expect(run({ lease: { ...live, acquiredAt: new Date(0).toISOString(), renewedAt: new Date().toISOString(), at: sha, branch: 'lane/target' } }).check()).toEqual({ exempt: true });
  });
  it('refuses lease at different from HEAD', () => expect(run({ head: 'b'.repeat(40) }).check).toThrow());
  it('refuses a moved branch tip', () => expect(run({ tip: 'b'.repeat(40) }).check).toThrow());
  it('refuses unreadable origin despite a matching cached tip', () => expect(run({ fetchFails: true }).check).toThrow());
  it.each([{ at: sha }, { branch: 'lane/target' }, {}, { at: 'short', branch: 'lane/target' }])('refuses incomplete lease %j', lease => expect(run({ lease }).check).toThrow());
  it('stale-runner override cannot bypass an invalid pin', () => expect(run({ head: 'b'.repeat(40), env: { WE_OPERATION_ALLOW_STALE: '1' } }).check).toThrow());
  it('refuses an unreadable lease', () => expect(run({ unreadable: true }).check).toThrow());
});
