import { it, expect } from 'vitest';
import { markFixPushAwaitingCi } from '../fix-push-ci.mjs';
import { resolveHandoffSettings } from '../../lib/handoff-settings.mjs';
it('creates missing CI labels before applying them and supports a same-head retry', () => {
  const labels = new Set();
  let edits = 0;
  const run = (cmd, args) => {
    expect(cmd).toBe('gh');
    expect(args).toContain('--repo=o/r');
    if (args[0] === 'label' && args[1] === 'create') {
      expect(args).toContain('--force');
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
  expect(calls.map(args => args.slice(0, 2))).toEqual([['pr', 'view'], ['label', 'create']]);
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
