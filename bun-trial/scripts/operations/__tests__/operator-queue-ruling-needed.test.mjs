import { it, expect, afterEach, mock, spyOn } from 'bun:test';
const __actual0 = { ...(await import('node:child_process')) };
mock.module('node:child_process', () => {
  const actual = __actual0;
  const execFileSync = mock(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
import { execFileSync } from 'node:child_process';
const __actual1 = { ...(await import('../../../../scripts/lib/gh-throttle.mjs')) };
mock.module('../../../../scripts/lib/gh-throttle.mjs', () => ({ ...__actual1, execFileSyncThrottled: (...args) => execFileSync(...args) }));
import { main } from '../../../../scripts/operations/operator-queue.mjs';
import { H1, record, recordComment, SUMMARY } from '../../../../scripts/conveyor/__tests__/ruling-fixtures.mjs';

afterEach(() => { mock.restore(); mock.clearAllMocks(); });

// PR #3794's live shape: parked on review:human, advisory:changes, findings waiting on a ruling.
const pr = { number: 3794, title: 'policy pointers', headRefOid: H1, mergeable: 'MERGEABLE', statusCheckRollup: [],
  labels: [{ name: 'review:human' }, { name: 'advisory:changes' }], comments: [recordComment(record({ head: H1, runId: 'run-1' }), 5)] };

it('shows a RULING NEEDED section (JSON and text) with each finding and its file, for a PR that is not ready', () => {
  execFileSync.mockImplementation((cmd, args) => (args[3] === 'web-everything/web-everything' ? JSON.stringify([pr]) : '[]'));
  const log = spyOn(console, 'log').mockImplementation(() => {});
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
