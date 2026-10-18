import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as labelProvider from '../../../lib/review-label-provider.mjs';
import * as childProcess from 'node:child_process';
import { buildLedgerEvent } from '../../../lib/verdict-ledger.mjs';
import { buildDerivedRows } from '../../../review-ledger-check.mjs';
import { runMirrorApply } from '../../pr-label-mirror.mjs';
import b, { mirrorFixtureOptions } from './mandatory-ruling-ledger-mirror.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  const forbidden = () => { throw new Error('unexpected external process in isolated soak'); };
  const blocked = Object.fromEntries(
    ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn', 'fork'].map(name => [name, vi.fn(forbidden)]),
  );
  return { ...actual, ...blocked, default: { ...actual.default, ...blocked } };
});

beforeEach(() => {
  vi.clearAllMocks();
  const forbidden = () => { throw new Error('unexpected external process/provider in isolated soak'); };
  vi.spyOn(labelProvider, 'createGhProvider').mockImplementation(forbidden);
});
afterEach(() => {
  try {
    expect(labelProvider.createGhProvider).not.toHaveBeenCalled();
    for (const name of ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn', 'fork']) {
      expect(childProcess[name]).not.toHaveBeenCalled();
    }
  } finally { vi.restoreAllMocks(); }
});

defineBreakTest(b);

it('forced open referral reaches the in-memory advisory writer and clears there after a ruling', async () => {
  const repo = 'example/ruling-mirror', pr = 7, head = 'a'.repeat(40);
  const base = { repo, pr, at: '2026-10-18T01:34:42Z', source: 'test' };
  const rows = [buildLedgerEvent({ ...base, type: 'referral', headSha: head, findingKeys: ['finding-1'] })];
  const labels = new Set(), writes = [];
  const facts = { state: 'OPEN', headSha: head, head: { sha: head }, labels: [], checks: [],
    requiredChecks: [{ name: 'test', state: 'green' }], probeErrors: [] };
  const opts = mirrorFixtureOptions({ repo, pr, rows, facts, labels, writes,
    append: row => { rows.push(row); return { ok: true }; }, buildDerivedRows });
  expect((await runMirrorApply(opts)).failures).toEqual([]);
  expect(writes).toContain('advisory:ruling-needed');
  expect(labels.has('advisory:ruling-needed')).toBe(true);
  rows.push(buildLedgerEvent({ ...base, type: 'ruling', findingKey: 'finding-1', ruling: 'not-real' }));
  expect((await runMirrorApply(opts)).failures).toEqual([]);
  expect(labels.has('advisory:ruling-needed')).toBe(false);
});
