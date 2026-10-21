import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { AUTOMATION_LOGINS, OPERATOR_LOGINS } from '../../lib/marker-authorship.mjs';
import { NOTE_COMMENT_MARKER } from '../../conveyor/reconcile-note-comment.mjs';
import { latestUnresolvedPersonNote, needsPersonRow } from '../operator-queue-needs-person.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original();
  const execFileSync = vi.fn(() => '[]');
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});
vi.mock('../../lib/gh-throttle.mjs', async (original) => ({ ...await original(), execFileSyncThrottled: (...args) => execFileSync(...args) }));
const { main } = await import('../operator-queue.mjs');
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const headline = 'needs your decision: auto-repair rounds exhausted';
const detail = 'PR #5270: fix auto-repair rounds exhausted (6/5) — a person must take it over (the takeover budget is spent: 2 of 2)';
const note = (createdAt = '2026-10-15T01:00:00Z', body = `${NOTE_COMMENT_MARKER}\n\n${headline}\n\n${detail}\n\n<!-- conveyor-note-key: round-cap-exhausted:5270:fix:6/5 -->`) => ({
  createdAt, body, author: { login: AUTOMATION_LOGINS[0] },
});
const operator = (createdAt, body = 'I have acted') => ({ createdAt, body, author: { login: OPERATOR_LOGINS[0] } });

describe('latestUnresolvedPersonNote', () => {
  it('parses the exact round-cap note', () => {
    expect(latestUnresolvedPersonNote([note()])).toEqual({ createdAt: note().createdAt, headline, detail,
      key: 'round-cap-exhausted:5270:fix:6/5', kind: 'round-cap-exhausted' });
  });
  it('selects the latest timestamp even when the array is unsorted', () => {
    const newer = note('2026-10-15T02:00:00Z', `${NOTE_COMMENT_MARKER}\nnew question`);
    expect(latestUnresolvedPersonNote([newer, note()])).toEqual({ createdAt: newer.createdAt,
      headline: 'new question', detail: null, key: null, kind: null });
  });
  it('keeps array order for equal timestamps', () => {
    expect(latestUnresolvedPersonNote([note(), note(note().createdAt, `${NOTE_COMMENT_MARKER}\nlast question`)])?.headline).toBe('last question');
  });
  it('resolves when any later operator reply exists', () => {
    expect(latestUnresolvedPersonNote([operator('2026-10-15T02:00:00Z'), note()])).toBeNull();
  });
  it('does not resolve for a prior grant or a same-time reply', () => {
    expect(latestUnresolvedPersonNote([operator('2026-10-15T00:00:00Z', '➕ conveyor — review round extension granted'),
      note(), operator(note().createdAt)])?.headline).toBe(headline);
  });
  it('ignores untrusted notes and untrusted replies', () => {
    const forged = { ...note('2026-10-15T02:00:00Z'), author: { login: 'untrusted-outsider' } };
    expect(latestUnresolvedPersonNote([forged])).toBeNull();
    expect(latestUnresolvedPersonNote([note(), forged])?.createdAt).toBe(note().createdAt);
  });
  it('requires the marker at the start and ignores HTML comments as detail', () => {
    expect(latestUnresolvedPersonNote([note(undefined, `quoted ${NOTE_COMMENT_MARKER}\nquestion`)])).toBeNull();
    expect(latestUnresolvedPersonNote([note(undefined, `${NOTE_COMMENT_MARKER}\nquestion\n<!-- other -->\nanswer`)])?.detail).toBe('answer');
    expect(latestUnresolvedPersonNote([])).toBeNull();
  });
});

it('builds commands with the repo and number, or returns null without a note', () => {
  expect(needsPersonRow('o/n', { number: 5270, comments: [] })).toBeNull();
  const row = needsPersonRow('o/n', { number: 5270, title: 'repair', comments: [note()] });
  expect(row).toMatchObject({ repo: 'o/n', number: 5270, title: 'repair', noteAt: note().createdAt, headline, detail, kind: 'round-cap-exhausted' });
  expect(row.commands).toEqual({
    extendRounds: "node scripts/operations/run.mjs extend-rounds --repo=o/n --pr=5270 --by=1 --actor=<your login> --channel='<where you ruled>' --reason='<your words>'",
    sendBack: "node scripts/review-set-label.mjs 5270 --repo=o/n --to=changes --body-file=<fix-list.md> --actor=<your login> --channel='<where you ruled>'",
    standDownAnswer: "node scripts/conveyor/stand-down-answer.mjs 5270 --repo=o/n --actor=<your login> --channel='<where you ruled>' --reason='<your answer>'",
    close: "gh pr close 5270 --repo=o/n --comment='<why>'",
  });
});

it('#5647: prints the withdrawn draft release command under NEEDS YOU without executing it', () => {
  execFileSync.mockReturnValue(JSON.stringify([{ number: 5647, title: 'withdrawn draft', isDraft: true,
    headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', comments: [], statusCheckRollup: [],
    labels: [{ name: 'review-status:draft-withdrawn' }] }]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  main(['--repo=o/n'], {});
  const output = log.mock.calls.map(c => c[0]).join('\n');
  expect(output).toContain('NEEDS YOU');
  expect(output).toContain('release draft: gh pr edit 5647 --repo=o/n --remove-label review-status:draft-withdrawn');
  expect(output).not.toContain('extend rounds: undefined');
  expect(execFileSync.mock.calls.some(([, args]) => args.includes('edit') || args.includes('ready'))).toBe(false);
});

it('main moves a review:human PR to NEEDS YOU, retaining its reasons; also lists non-human PRs', () => {
  const prs = [5270, 5271].map(number => ({ number, title: 'repair', headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE',
    statusCheckRollup: [], labels: (number === 5270 ? ['review:human', 'status:escalated'] : ['status:at-round-limit']).map(name => ({ name })), comments: [note()] }));
  execFileSync.mockReturnValue(JSON.stringify(prs));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  main(['--repo=o/n', '--json'], {});
  const report = JSON.parse(log.mock.calls[0][0]);
  expect(report.needsPerson.map(row => row.number)).toEqual([5270, 5271]);
  expect(report.needsPerson[0].alsoNotReady.length).toBeGreaterThan(0);
  expect(report.needsPerson[1].alsoNotReady).toEqual([]);
  expect(report.notReady).toEqual([]);
  log.mockClear();
  main(['--repo=o/n'], {});
  const text = log.mock.calls.flat().join('\n');
  const needsYou = text.split('RULING NEEDED')[0];
  expect(needsYou).toContain(`o/n#5270  repair  [conveyor asks since ${note().createdAt}] ${headline} — ${detail}`);
  for (const label of ['extend rounds', 'send back past the cap', 'answer the stand-down', 'close']) expect(needsYou).toContain(`    ${label}: `);
  expect(text.split('NOT READY')[1].split('STOOD DOWN')[0]).not.toContain('o/n#5270');
});
