import { describe, it, expect, vi } from 'vitest';
import { withReviewTick, memoReviewGh, resolveReviewTickSettings, timeReviewStep } from '../review-tick-memo.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync } from '../gh-throttle.mjs';
import { createGhProvider } from '../review-label-provider.mjs';
import { readNetFileSets } from '../../operations/free-scope-io.mjs';
import { readHumanSurfaceNetFiles } from '../human-surface-net-diff.mjs';

const settings = { memoize: 'on', stepTimings: 'on' };
const tick = (fn, extra = {}) => withReviewTick(fn, { settings, log: () => {}, ...extra });
const view = ['pr', 'view', '1', '--repo', 'o/r', '--json', 'headRefOid,labels,body'];
const headRead = ['pr', 'view', '1', '--repo', 'o/r', '--json', 'headRefOid'];
const count = ['api', 'graphql', '-f', 'query=query{comments{totalCount}}', '-F', 'owner=o', '-F', 'name=r', '-F', 'n=1'];
const gh = (args, read) => memoReviewGh(args, {}, read);
const state = head => JSON.stringify({ headRefOid: head, labels: [] });
const row = { number: 1, headRefOid: 'a'.repeat(40) };
function gitFixture(fails = false) {
  return vi.fn((_dir, args) => {
    if (args[0] === 'fetch' && fails) throw new Error('offline');
    if (args[0] === 'merge-base') return 'b'.repeat(40);
    if (args[0] === 'diff') return 'M\0example.mjs\0';
    return '';
  });
}
const net = git => readNetFileSets({ dir: '.', rows: [row], git }).get(1);

describe('review tick memo', () => {
  it('the real throttled provider reuses PR views and GraphQL counts', () => {
    const lockRoot = mkdtempSync(join(tmpdir(), 'review-tick-memo-'));
    const exec = vi.fn(args => {
      if (args[0] === 'pr') return state('a');
      if (args.includes('graphql')) return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 0 } } } } });
      return '';
    });
    const provider = createGhProvider({ exec: (args, opts) => runGhSync(args, {
      ...opts, encoding: 'utf8', throttle: { exec, lockRoot, cap: 2, sleep: () => {} },
    }) });
    try {
      tick(() => {
        provider.readPrState('o/r', 1); provider.readPrState('o/r', 1);
        provider.readComments('o/r', 1); provider.readComments('o/r', 1);
      });
      expect(exec.mock.calls.filter(([a]) => a[0] === 'pr')).toHaveLength(1);
      expect(exec.mock.calls.filter(([a]) => a.includes('graphql'))).toHaveLength(1);
    } finally { rmSync(lockRoot, { recursive: true, force: true }); }
  });
  it('cache hit for PR view and comment count within a tick', () => tick(() => {
    const read = vi.fn(() => state('a'));
    expect(gh(view, read)).toBe(gh(view, read));
    const comments = vi.fn(() => 'count');
    gh(count, comments); gh(count, comments);
    expect(read).toHaveBeenCalledTimes(1);
    expect(comments).toHaveBeenCalledTimes(1);
  }));
  it('head change misses both PR view and comment count; head probes stay live', () => tick(() => {
    const read = vi.fn(() => state('a')), comments = vi.fn(() => 'count');
    gh(view, read); gh(count, comments);
    gh(headRead, () => state('b'));
    read.mockImplementation(() => state('b'));
    gh(view, read); gh(count, comments);
    expect(read).toHaveBeenCalledTimes(2);
    expect(comments).toHaveBeenCalledTimes(2);
  }));
  it('new tick misses and calls outside a tick are uncached', () => {
    const read = vi.fn(() => state('a'));
    tick(() => gh(view, read)); tick(() => gh(view, read));
    gh(view, read); gh(view, read);
    expect(read).toHaveBeenCalledTimes(4);
  });
  it('main run list is cached per repo, without conflating different queries', () => tick(() => {
    const read = vi.fn(() => '[]');
    const args = ['run', 'list', '--branch', 'main', '--repo', 'o/r'];
    gh(args, read); gh(args, read);
    gh(['pr', 'edit', '1'], () => ''); gh(args, read);
    gh([...args.slice(0, -1), 'o/other'], read);
    expect(read).toHaveBeenCalledTimes(2);
  }));
  it('main-run failures remain failures and are read only once per tick', () => tick(() => {
    const read = vi.fn(() => { throw new Error('unreadable'); });
    const args = ['run', 'list', '--branch=main', '--repo=o/r'];
    expect(() => gh(args, read)).toThrow('unreadable');
    expect(() => gh(args, read)).toThrow('unreadable');
    expect(read).toHaveBeenCalledTimes(1);
  }));
  it('a PR mutation invalidates read evidence', () => tick(() => {
    const read = vi.fn(() => state('a'));
    gh(view, read); gh(['pr', 'edit', '1', '--repo', 'o/r', '--add-label', 'hold'], () => ''); gh(view, read);
    expect(read).toHaveBeenCalledTimes(2);
  }));
  it('fetches main once across free-scope and human-surface reads, then again next tick', () => {
    const git = gitFixture();
    tick(() => {
      expect(net(git).ok).toBe(true);
      expect(readHumanSurfaceNetFiles({ ...row, repo: 'o/r' }, { git, gitDirFor: () => '.' }).ok).toBe(true);
    });
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(1);
    tick(() => net(git));
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(2);
  });
  it('fetch failure fails closed for the tick, never diffing a stale base', () => tick(() => {
    const git = gitFixture(true);
    expect(net(git)).toEqual({ ok: false, reason: 'fetch failed' });
    expect(net(git)).toEqual({ ok: false, reason: 'fetch failed' });
    expect(readHumanSurfaceNetFiles({ ...row, repo: 'o/r' }, { git, gitDirFor: () => '.' })).toEqual({ ok: false, reason: 'fetch failed' });
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(1);
    expect(git.mock.calls.some(([, a]) => a[0] === 'diff')).toBe(false);
  }));
  it('fetches newly encountered missing heads without refetching main', () => tick(() => {
    const git = gitFixture();
    net(git);
    git.mockImplementationOnce(() => { throw new Error('missing head'); });
    expect(net(git).ok).toBe(true);
    const fetches = git.mock.calls.filter(([, a]) => a[0] === 'fetch').map(([, a]) => a);
    expect(fetches).toHaveLength(2);
    expect(fetches[1]).toContain('refs/pull/1/head');
    expect(fetches[1].some(a => a.startsWith('+refs/heads/'))).toBe(false);
  }));
  it('keeps independent checkout fetches apart', () => tick(() => {
    const git = gitFixture();
    net(git);
    readNetFileSets({ dir: 'other', rows: [row], git });
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(2);
  }));
  it('async ticks retain the memo across awaits, then expire', async () => {
    const read = vi.fn(() => state('a'));
    await tick(async () => { gh(view, read); await Promise.resolve(); gh(view, read); });
    tick(() => gh(view, read));
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('setting off restores uncached reads and per-read fetches', () => tick(() => {
    const read = vi.fn(() => state('a')), git = gitFixture();
    gh(view, read); gh(view, read); net(git); net(git);
    expect(read).toHaveBeenCalledTimes(2);
    expect(git.mock.calls.filter(([, a]) => a[0] === 'fetch')).toHaveLength(2);
  }, { settings: { ...settings, memoize: 'off' } }));
  it('emits one summary including zero-cost steps, even on failure; timing off is silent', () => {
    const log = vi.fn(); let ms = 0;
    expect(() => tick(() => timeReviewStep('list', () => { ms += 7; throw new Error('read'); }), { log, now: () => ms })).toThrow('read');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('pass timings: setup=0ms list=7ms ledger-read=0ms per-PR-loop=0ms human-surface=0ms free-scope=0ms label-provider=0ms total=7ms');
    tick(() => {}, { log, settings: { ...settings, stepTimings: 'off' } });
    expect(log).toHaveBeenCalledTimes(1);
  });
  it('settings use per-file leaves and log tool/platform provenance', () => {
    const log = vi.fn();
    const r = resolveReviewTickSettings({ env: { WE_POLICY_CASCADE_LOG: '1' }, platform: { tick: { memoize: 'off' } }, read: () => ({ review: { tick: { stepTimings: 'on' } } }), log });
    expect(r.value).toEqual({ tick: { memoize: 'off', stepTimings: 'on' } });
    expect(r.sources['tick.memoize']).toBe('platform');
    expect(r.sources['tick.stepTimings']).toBe('tool');
    expect(log).toHaveBeenCalled();
    expect(resolveReviewTickSettings({ env: {}, platform: {}, log: () => {} }).sources['tick.memoize']).toBe('tool');
    expect(resolveReviewTickSettings({ env: {}, platform: {}, read: () => ({ review: { tick: { memoize: 'invalid' } } }), log: () => {} }).value.tick.memoize).toBe('off');
  });
});
