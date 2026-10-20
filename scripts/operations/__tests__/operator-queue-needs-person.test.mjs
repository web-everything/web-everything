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

describe('#5773: a card-batch hold the seal job still owns is PARKED, not NEEDS YOU', () => {
  const pr = { number: 5773, title: 'Admit card "xn5h9sy"', isDraft: true, state: 'OPEN',
    headRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE', comments: [], statusCheckRollup: [],
    labels: [{ name: 'review:pending' }, { name: 'review-status:draft-withdrawn' }] };
  const owned = { status: 'owned', kind: 'filing', batchRef: 'lane/card-batch-filing-4', headSha: 'b'.repeat(40), members: 1, dueAt: '2026-10-20T19:46:24.138Z', reason: null };

  it('returns a parked row with no release command for an owned hold', () => {
    const row = needsPersonRow('o/n', pr, { cardBatchHold: () => owned, withdrawalEvidence: () => null });
    expect(row).toMatchObject({ parked: true, kind: 'card-batch-held', number: 5773, batchRef: 'lane/card-batch-filing-4' });
    expect(row.commands).toBeUndefined();
  });

  it.each(['failed', 'overdue', 'done'])('keeps a %s hold in NEEDS YOU with the release command and the cause', (status) => {
    const row = needsPersonRow('o/n', pr, { cardBatchHold: () => ({ ...owned, status, reason: `cause-${status}` }) });
    expect(row.parked).toBeUndefined();
    expect(row.detail).toContain(`cause-${status}`);
    expect(row.commands.releaseDraft).toBe('gh pr edit 5773 --repo=o/n --remove-label review-status:draft-withdrawn');
  });

  it('keeps it in NEEDS YOU when the PR head moved off the batch head (someone else is acting on it)', () => {
    const row = needsPersonRow('o/n', { ...pr, headRefOid: 'c'.repeat(40) }, { cardBatchHold: () => owned });
    expect(row.parked).toBeUndefined();
    expect(row.headline).toContain('(moved)');
    expect(row.commands.releaseDraft).toContain('--remove-label review-status:draft-withdrawn');
  });

  it.each([
    ['fixer evidence', () => 'a fix claim (fixing) exists for this PR, held by fixer-1'],
    ['a failing evidence read', () => { throw new Error('EIO'); }],
    ['no evidence reader', undefined],
  ])('keeps an owned hold in NEEDS YOU on %s', (_name, withdrawalEvidence) => {
    const row = needsPersonRow('o/n', pr, { cardBatchHold: () => owned, withdrawalEvidence });
    expect(row.parked).toBeUndefined();
    expect(row.headline).toContain('(fixer-evidence)');
    expect(row.commands.releaseDraft).toContain('--remove-label review-status:draft-withdrawn');
  });

  it('main keeps an owned hold in NEEDS YOU when the evidence read finds a fixer withdrawal', () => {
    execFileSync.mockReturnValue(JSON.stringify([pr]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    main(['--repo=o/n', '--json'], { readCardBatchHolds: () => ({ holds: new Map([['o/n#5773', owned]]), errors: [] }),
      withdrawalEvidence: () => 'a fix-begin claim comment is on this PR' });
    const report = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(report.parked ?? []).toEqual([]);
    expect(report.needsPerson).toMatchObject([{ number: 5773, kind: 'draft-withdrawn' }]);
    expect(report.needsPerson[0].detail).toContain('fix-begin claim comment');
  });

  it('keeps an unknown withdrawn draft in NEEDS YOU exactly as before', () => {
    const row = needsPersonRow('o/n', pr, { cardBatchHold: () => null });
    expect(row).toMatchObject({ kind: 'draft-withdrawn', headline: 'Withdrawn draft — explicit operator release required' });
  });

  it('main lists the owned hold under PARKED, not NEEDS YOU, and never edits the PR', () => {
    execFileSync.mockReturnValue(JSON.stringify([pr]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const readCardBatchHolds = vi.fn(() => ({ holds: new Map([['o/n#5773', owned]]), errors: [] }));
    main(['--repo=o/n', '--json'], { readCardBatchHolds, withdrawalEvidence: () => null });
    const report = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(report.needsPerson).toEqual([]);
    expect(report.parked).toMatchObject([{ number: 5773, kind: 'card-batch-held' }]);
    expect(readCardBatchHolds).toHaveBeenCalledTimes(1);
    expect(execFileSync.mock.calls.some(([, args]) => args.includes('edit') || args.includes('ready'))).toBe(false);
  });

  it('main keeps the row in NEEDS YOU and reports the error when the batch state cannot be read', () => {
    execFileSync.mockReturnValue(JSON.stringify([pr]));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    main(['--repo=o/n', '--json'], { readCardBatchHolds: () => { throw new Error('EACCES'); } });
    const report = JSON.parse(log.mock.calls.at(-1)[0]);
    expect(report.needsPerson).toMatchObject([{ number: 5773, kind: 'draft-withdrawn' }]);
    expect(report.errors.join(' ')).toContain('card-batch holds unavailable: EACCES');
  });
});
