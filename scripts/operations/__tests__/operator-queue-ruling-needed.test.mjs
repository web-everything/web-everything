import { afterEach, expect, it, vi } from 'vitest';
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFileSync = vi.fn(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
import { execFileSync } from 'node:child_process';
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({ ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args) }));
import { main } from '../operator-queue.mjs';
import { H1, record, recordComment, SUMMARY } from '../../conveyor/__tests__/ruling-fixtures.mjs';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

// PR #3794's live shape: parked on review:human, advisory:changes, findings waiting on a ruling.
const pr = { number: 3794, title: 'policy pointers', headRefOid: H1, mergeable: 'MERGEABLE', statusCheckRollup: [],
  labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], comments: [recordComment(record({ head: H1, runId: 'run-1' }), 5)] };

it('shows a RULING NEEDED section (JSON and text) with each finding and its file, for a PR that is not ready', () => {
  execFileSync.mockImplementation((cmd, args) => (args[3] === 'web-everything/web-everything' ? JSON.stringify([pr]) : '[]'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  main(['--json', '--repo=web-everything/web-everything'], {});
  const report = JSON.parse(log.mock.calls[0][0]);
  expect(report.ready).toEqual([]);
  expect(report.rulingNeeded).toHaveLength(1);
  expect(report.rulingNeeded[0]).toMatchObject({ number: 3794, head: H1, findings: [{ file: 'policy/pointer.md', summary: SUMMARY }] });
  log.mockClear();
  main(['--repo=web-everything/web-everything'], {});
  const text = log.mock.calls.flat().join('\n');
  expect(text).toMatch(/RULING NEEDED/);
  expect(text).toMatch(/web-everything\/web-everything#3794/);
  expect(text).toContain('policy/pointer.md:12');
});
