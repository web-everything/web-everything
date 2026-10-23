import { it, expect, beforeEach, afterEach, vi } from 'vitest';

// These adapter assertions exercise uncached argv; label-cache.test.mjs covers shared caching.
beforeEach(() => vi.stubEnv('WE_LABELS_CACHE_TTL_MS', '0'));
afterEach(() => vi.unstubAllEnvs());

import { markFixPushAwaitingCi } from '../fix-push-ci.mjs';
import { resolveHandoffSettings } from '../../lib/handoff-settings.mjs';
it('creates missing CI labels before applying them and supports a same-head retry', () => {
  const labels = new Set();
  let edits = 0;
  const run = (cmd, args) => {
    expect(cmd).toBe('gh');
    expect(args).toContain('--repo=o/r');
    if (args[0] === 'label' && args[1] === 'create') {
      expect(args).not.toContain('--force');
      labels.add(args[2]);
      return '';
    }
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels: [] });
    if (args[1] === 'edit') {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--add-label' && !labels.has(args[i + 1])) {
          throw new Error(`could not add label: '${args[i + 1]}' not found`);
        }
      }
      edits += 1;
      return '';
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };
  const push = { repo: 'o/r', pr: 7, head: 'abc' };
  const deps = { run, recordPush: () => {} };
  expect(markFixPushAwaitingCi(push, deps)).toBe(true);
  expect(markFixPushAwaitingCi(push, deps)).toBe(true);
  expect(labels).toEqual(new Set(['checking', 'status:awaiting-ci']));
  expect(edits).toBe(2);
});
it('labels the pushed head awaiting CI and removes stale red labels', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, recordPush: () => {} })).toBe(true);
  expect(calls[3]).toEqual(expect.arrayContaining(['--add-label', 'checking', '--add-label', 'status:awaiting-ci', '--remove-label', 'ci:failed', '--remove-label', 'status:ci-red']));
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'moved' }, { run, recordPush: () => {} })).toBe(false);
  expect(calls).toHaveLength(5);
});
it('retains the push record and stops before editing when label creation fails', () => {
  const push = { repo: 'o/r', pr: 7, head: 'abc' };
  const recorded = [];
  const calls = [];
  const run = (cmd, args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify({ headRefOid: 'abc', labels: [] });
    throw new Error('label creation unavailable');
  };
  expect(() => markFixPushAwaitingCi(push, { run, recordPush: value => recorded.push(value) })).toThrow('label creation unavailable');
  expect(recorded).toEqual([push]);
  expect(calls.map(args => args.slice(0, 2))).toEqual([['pr', 'view'], ['label', 'create'], ['label', 'list']]);
});
it('a same-head retry after a required check failed keeps the red verdict and drops only fixer state', () => {
  const calls = [];
  const rollup = [
    { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'smoke', state: 'PENDING' },
  ];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', statusCheckRollup: rollup, labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }, { name: 'status:fixing' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, recordPush: () => {}, readRequired: () => ['test', 'smoke'] })).toBe(false);
  expect(calls.map(a => a.slice(0, 2))).toEqual([['pr', 'view'], ['pr', 'edit']]);
  expect(calls[1]).toEqual(['pr', 'edit', '7', '--repo=o/r', '--remove-label', 'status:fixing']);
});
it('a same-head retry after CI went green drops the previous head\'s red labels without re-handing to CI', () => {
  const calls = [];
  const rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { __typename: 'StatusContext', context: 'smoke', state: 'SUCCESS' }];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', statusCheckRollup: rollup, labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, recordPush: () => {}, readRequired: () => ['test', 'smoke'] })).toBe(false);
  expect(calls[1]).toEqual(['pr', 'edit', '7', '--repo=o/r', '--remove-label', 'ci:failed', '--remove-label', 'status:ci-red']);
});
it('headCiVerdict judges required checks only: partial, unknown and missing-status rows are pending', async () => {
  const { headCiVerdict, readRequiredChecksSafe } = await import('../fix-push-ci.mjs');
  const run = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, ...(conclusion ? { conclusion } : {}) });
  const req = ['test', 'smoke'];
  expect(headCiVerdict(undefined, req)).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS')], req)).toBe('pending'); // smoke never reported
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), run('smoke', 'COMPLETED', 'SUCCESS')], [])).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), { name: 'smoke' }], req)).toBe('pending');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), run('smoke', 'COMPLETED', 'NEUTRAL'), run('merge-gate', 'COMPLETED', 'FAILURE')], req)).toBe('green');
  expect(headCiVerdict([run('test', 'COMPLETED', 'TIMED_OUT'), run('smoke', 'QUEUED')], req)).toBe('red');
  expect(headCiVerdict([run('test', 'COMPLETED', 'SUCCESS'), { __typename: 'StatusContext', context: 'smoke', state: 'ERROR' }], req)).toBe('red');
  expect(readRequiredChecksSafe('o/r', () => { throw new Error('403'); })).toEqual([]);
});
it('a held merge-gate (a review or freeze hold, not CI) is never a red verdict under the live required set', async () => {
  const { headCiVerdict } = await import('../fix-push-ci.mjs');
  const live = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'];
  const row = (name, status, conclusion) => ({ __typename: 'CheckRun', name, status, ...(conclusion ? { conclusion } : {}) });
  const queued = [row('test', 'QUEUED'), row('smoke', 'QUEUED'), row('daemon-soak', 'QUEUED')];
  expect(headCiVerdict([...queued, row('merge-gate', 'COMPLETED', 'FAILURE'), row('soak-replay-gate', 'IN_PROGRESS')], live)).toBe('pending');
  const green = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'].map(n => row(n, 'COMPLETED', 'SUCCESS'));
  // A failing merge-gate never decides red, but blocks green: the head stays pending (an ordinary hand-off).
  expect(headCiVerdict([...green, row('merge-gate', 'COMPLETED', 'FAILURE')], live)).toBe('pending');
  expect(headCiVerdict([...green, row('merge-gate', 'COMPLETED', 'SUCCESS')], live)).toBe('green');
  expect(headCiVerdict([...green.slice(1), row('test', 'COMPLETED', 'FAILURE'), row('merge-gate', 'IN_PROGRESS')], live)).toBe('red');
  // A required set replaces the shared exclusion list: a required soak-replay-gate failure is CI red.
  expect(headCiVerdict([...green.slice(0, 3), row('soak-replay-gate', 'COMPLETED', 'FAILURE'), row('merge-gate', 'COMPLETED', 'SUCCESS')], live)).toBe('red');
});
it('a finished verdict also clears an earlier hand-off\'s waiting labels', async () => {
  const { fixPushLabelPlan } = await import('../fix-push-ci.mjs');
  const present = ['checking', 'status:awaiting-ci', 'ci:failed', 'status:ci-red', 'status:awaiting-review'];
  expect(fixPushLabelPlan(present, 'green')).toEqual({ handOff: false, remove: ['checking', 'status:awaiting-ci', 'ci:failed', 'status:ci-red'] });
  expect(fixPushLabelPlan(present, 'red')).toEqual({ handOff: false, remove: ['checking', 'status:awaiting-ci', 'status:awaiting-review'] });
  expect(fixPushLabelPlan(present, 'pending').handOff).toBe(true);
});
it('resolves missing-CI timing per leaf through the cascade', () => {
  const out = resolveHandoffSettings('fix', { tool: { ciMissingAfterPushMin: 12 }, platform: { ciMissingAfterPushMin: 15, sendBackReservedSlots: 2 }, env: {} });
  expect(out.value).toEqual({ ciMissingAfterPushMin: 12, sendBackReservedSlots: 2 });
  expect(out.sources).toMatchObject({ ciMissingAfterPushMin: 'tool', sendBackReservedSlots: 'platform' });
});

import { recordFixPush, readFixPush } from '../fix-push-state.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it('ages missing CI from the push, preserving that time on a same-head retry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fix-push-'));
  try {
    const key = { repo: 'o/r', pr: 7, head: 'abc' };
    const first = recordFixPush(key, { dir, now: () => 1000 });
    expect(recordFixPush(key, { dir, now: () => 60_000 })).toEqual(first);
    expect(readFixPush({ ...key, head: 'other' }, { dir })).toBeNull();
    expect(recordFixPush({ ...key, head: 'other' }, { dir, now: () => 60_000 }).pushedAt).toBe(new Date(60_000).toISOString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
