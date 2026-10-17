import { it, expect } from 'vitest';
import { markFixPushAwaitingCi } from '../fix-push-ci.mjs';
import { resolveHandoffSettings } from '../../lib/handoff-settings.mjs';
it('labels the pushed head awaiting CI and removes stale red labels', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push(args); return JSON.stringify({ headRefOid: 'abc', labels: [{ name: 'ci:failed' }, { name: 'status:ci-red' }] }); };
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'abc' }, { run, recordPush: () => {} })).toBe(true);
  expect(calls[1]).toEqual(expect.arrayContaining(['--add-label', 'checking', '--add-label', 'status:awaiting-ci', '--remove-label', 'ci:failed', '--remove-label', 'status:ci-red']));
  expect(markFixPushAwaitingCi({ repo: 'o/r', pr: 7, head: 'moved' }, { run, recordPush: () => {} })).toBe(false);
  expect(calls).toHaveLength(3);
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
