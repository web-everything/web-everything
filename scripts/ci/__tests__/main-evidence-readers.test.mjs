// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadReports, downloadRuns, expectedUnitShards } from '../refresh-timings.mjs';
import { currentMainGreen, computeMainRedWindows } from '../../conveyor/main-red-recovery.mjs';
import { defaultReadMainRuns } from '../../conveyor/reconcile-pass.mjs';
it('timings selects full queue/schedule runs past a skipped-success push, for latest and rolling downloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-evidence-'));
  const downloads = [];
  const exec = (_, args) => {
    if (args[1] === 'list') return JSON.stringify([
      { databaseId: 103, event: 'push', headBranch: 'main' },
      { databaseId: 102, event: 'schedule', headBranch: 'main' },
      { databaseId: 101, event: 'merge_group', headBranch: 'gh-readonly-queue/main/pr-1', headSha: 'a'.repeat(40) },
    ]);
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'api') { const id = Number(/runs\/(\d+)/.exec(args[1])[1]);
      return JSON.stringify({ total_count: id === 103 ? 0 : expectedUnitShards().length, artifacts: id === 103 ? [] : expectedUnitShards().map(n => ({ name: `timing-unit-${n}`, expired: false })) }); }
    if (args[1] === 'download') { downloads.push(args[2]); return ''; }
    throw Error('unexpected IO');
  };
  try {
    await downloadReports('latest', dir, { exec }); expect(downloads).toEqual(['102']);
    downloads.length = 0; await downloadRuns(2, dir, { exec }); expect(downloads).toEqual(['102', '101']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
it('red-main IO includes schedule on main, and a later successful light push closes the red window', () => {
  const red = { databaseId: 10, workflowName: 'CI', event: 'schedule', headBranch: 'main', headSha: 'a'.repeat(40), status: 'completed', conclusion: 'failure', updatedAt: '2026-11-19T00:00:00Z' };
  const green = { ...red, databaseId: 11, event: 'push', conclusion: 'success', updatedAt: '2026-11-19T01:00:00Z' };
  const exec = (_, args) => {
    if (args[1] === 'repos/fixture/repo/git/ref/heads/main') return JSON.stringify({ object: { sha: red.headSha } });
    if (args[0] === 'api') return JSON.stringify({ total_count: 1, jobs: [{ name: 'test', conclusion: 'failure' }] });
    expect(args).not.toContain('--event=push'); expect(args).toContain('main'); return JSON.stringify([green, red]);
  };
  const runs = defaultReadMainRuns({ exec, repo: 'fixture/repo' });
  expect(currentMainGreen([runs[1]]).red).toBe(true);
  expect(currentMainGreen(runs).red).toBe(false);
  expect(computeMainRedWindows(runs)).toEqual([{ start: red.updatedAt, end: green.updatedAt }]);
});

it.each(['stale', 'current', 'unreadable', 'malformed', 'missing head'])('schedule evidence requires a freshly readable current main tip: %s', kind => {
  const tip = 'b'.repeat(40);
  const red = { databaseId: 20, workflowName: 'CI', event: 'push', headSha: tip,
    status: 'completed', conclusion: 'failure', updatedAt: '2026-11-19T01:00:00Z' };
  const green = { ...red, databaseId: 19, event: 'schedule',
    headSha: kind === 'current' ? tip : kind === 'missing head' ? undefined : 'a'.repeat(40),
    updatedAt: '2026-11-19T02:00:00Z' };
  let tipReads = 0;
  const exec = (_, args) => {
    if (args[0] === 'run') {
      expect(args[args.indexOf('--json') + 1].split(',')).toContain('event');
      return JSON.stringify([green, red]);
    }
    if (args[1] === 'repos/fixture/repo/git/ref/heads/main') {
      tipReads++;
      if (kind === 'unreadable') throw new Error('tip unavailable');
      return JSON.stringify({ object: { sha: kind === 'malformed' ? 'unknown' : tip } });
    }
    return JSON.stringify({ total_count: 1, jobs: [{ name: 'test', conclusion: 'failure' }] });
  };
  green.conclusion = 'success';
  const runs = defaultReadMainRuns({ exec, repo: 'fixture/repo' });
  expect(tipReads).toBe(1);
  expect(currentMainGreen(runs)?.red).toBe(kind !== 'current');
  expect(computeMainRedWindows(runs)).toEqual([{ start: red.updatedAt, end: kind === 'current' ? green.updatedAt : null }]);
  expect(currentMainGreen(runs.filter(r => r.event === 'schedule'))?.red).toBe(kind === 'current' ? false : undefined);
});

it('timing search refuses an oversized inventory with an explicit-run fallback before downloading', async () => {
  const exec = (_, args) => {
    expect(args[1]).toBe('list');
    return JSON.stringify(Array.from({ length: 101 }, (_, n) => ({ databaseId: n + 1, event: 'push', headBranch: 'main' })));
  };
  await expect(downloadReports('latest', 'unused', { exec })).rejects.toThrow(/supply --run=<id>/);
});

it('timing artifact search stops at twenty reads and names the explicit-run fallback', async () => {
  let reads = 0;
  const exec = (_, args) => {
    if (args[1] === 'list') return JSON.stringify(Array.from({ length: 21 }, (_, n) => ({ databaseId: n + 1, event: 'push', headBranch: 'main' })));
    expect(args[0]).toBe('api'); reads++;
    return JSON.stringify({ total_count: 0, artifacts: [] });
  };
  await expect(downloadReports('latest', 'unused', { exec })).rejects.toThrow(/search bound reached; supply --run=<id>/);
  expect(reads).toBe(20);
});
