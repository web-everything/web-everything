import { describe, expect, it, vi } from 'vitest';
import { planStampRestore, restoreAuthorStamp, sweepAuthorStamps } from '../author-stamp-restore.mjs';
import { buildAuthorActorMarker, buildStampLostMarker, hasStampLostMarker, readAuthorActorStamps } from '../review-independence.mjs';

const ID = '01f39b97-274a-4078-8eeb-e7f8d6008673';
const OTHER = 'ffffffff-1111-2222-3333-444444444444';
const AUTHOR = 'plateau-worker';
const BODY = 'Resolve the review issue.\n\nOperator clarification.';
const edit = (diff, login = AUTHOR, createdAt = '2026-10-01T10:00:00Z') => ({
  diff, editor: { login }, createdAt,
});
// #6244: the author stamped the original; two later web edits by chalbert dropped it.
const history = () => [
  edit(`Original body\n\n${buildAuthorActorMarker(ID)}`),
  edit('First operator edit', 'chalbert', '2026-10-01T11:00:00Z'),
  edit(BODY, 'chalbert', '2026-10-01T12:00:00Z'),
];
// Live #6244 shape: full plain bodies, newest first; equal timestamps retain list order.
const plainHistory = () => [
  edit(BODY, 'chalbert', '2026-11-03T01:58:16Z'),
  edit('First operator edit', 'chalbert', '2026-11-02T13:10:21Z'),
  edit(`Original body\n\n${buildAuthorActorMarker(ID)}`, AUTHOR, '2026-11-02T13:10:21Z'),
];
const live = (body = BODY) => ({ state: 'OPEN', body, author: { login: AUTHOR } });
const plan = (overrides = {}) => planStampRestore({ state: 'OPEN', body: BODY, authorLogin: AUTHOR, edits: history(), ...overrides });
const expectReason = (result, action) => {
  expect(result).toEqual(expect.objectContaining({ action, reason: expect.any(String) }));
  expect(result.reason.trim()).not.toBe('');
};
function io(overrides = {}) {
  return { pr: 6244, repo: 'o/stamp-restore', readPr: vi.fn(() => live()),
    readEdits: vi.fn(history), writeBody: vi.fn(), log: vi.fn(), ...overrides };
}

describe('planStampRestore — agreement and author-of-record provenance', () => {
  it('recovers the verbatim actor id from the #6244 author snapshot', () => {
    const result = plan();
    expectReason(result, 'restore');
    expect(result.id).toBe(ID);
    expect(result.source).toBeDefined();
  });

  it('compares editor and author logins case-insensitively', () => {
    expect(plan({ authorLogin: 'PLATEAU-WORKER' })).toMatchObject({ action: 'restore', id: ID });
  });

  it.each(['app/plateau-worker', 'APP/PLATEAU-WORKER', 'plateau-worker'])(
    'restores a stamp supplied by the bot author %s', (authorLogin) => {
      expect(plan({ authorLogin })).toMatchObject({ action: 'restore', id: ID });
    });

  it.each(['app/other', 'app/', '', 'app/app/plateau-worker', 'plateau-worker[bot]', ' plateau-worker'])(
    'refuses a missing or nonmatching bot author %s', (authorLogin) => {
      expectReason(plan({ authorLogin }), 'refuse');
    });

  it('does not strip app/ from the editor login', () => {
    expectReason(plan({ authorLogin: 'app/plateau-worker',
      edits: [edit(buildAuthorActorMarker(ID), 'app/plateau-worker')] }), 'refuse');
  });

  it('allows repeated agreeing stamps, including snapshots by other editors', () => {
    expect(plan({ edits: [...history(), edit(buildAuthorActorMarker(ID), 'chalbert', '2026-10-01T13:00:00Z')] }))
      .toMatchObject({ action: 'restore', id: ID });
  });

  it.each([undefined, null, {}, 'unreadable'])('refuses missing/non-array history: %s', (edits) => {
    expectReason(plan({ edits }), 'refuse');
  });

  it.each([{ edits: [] }, { edits: [edit('never stamped')] }])('refuses history without a stamped snapshot: %j', ({ edits }) => {
    expectReason(plan({ edits }), 'refuse');
  });

  it.each(['', '   ', null, undefined])('refuses an empty authorLogin: %s', (authorLogin) => {
    expectReason(plan({ authorLogin }), 'refuse');
  });

  it('refuses different ids across history even when the author supplied one', () => {
    expectReason(plan({ edits: [...history(), edit(buildAuthorActorMarker(OTHER), 'chalbert')] }), 'refuse');
  });

  it('refuses two different ids within one author snapshot', () => {
    expectReason(plan({ edits: [edit(`${buildAuthorActorMarker(ID)}\n${buildAuthorActorMarker(OTHER)}`)] }), 'refuse');
  });

  it('refuses a stamp only supplied by another editor despite unstamped author edits', () => {
    expectReason(plan({ edits: [edit('author body'), edit(buildAuthorActorMarker(ID), 'chalbert')] }), 'refuse');
  });

  it.each([buildAuthorActorMarker(ID), `${buildAuthorActorMarker(ID)}\n${buildAuthorActorMarker(OTHER)}`])(
    'skips any live stamp, including an ambiguous live body: %s', (body) => {
      expectReason(plan({ body, edits: null }), 'skip');
    });

  it('skips a live stamp-lost marker', () => {
    expectReason(plan({ body: `${BODY}\n${buildStampLostMarker()}`, edits: null }), 'skip');
  });

  it.each(['CLOSED', 'MERGED'])('skips a non-OPEN PR: %s', (state) => {
    expectReason(plan({ state }), 'skip');
  });
});

describe('plain snapshot provenance — oldest author snapshot and agreeing ids', () => {
  it('refuses complete plain snapshots with a plus-prefixed forgery retained by the author without writing', async () => {
    const forgedLine = '+<!-- authored-by-actor: FORGED -->';
    const edits = [
      edit(`Later author revision\n${forgedLine}`, AUTHOR, '2026-11-03T12:00:00Z'),
      edit(`Third-party body\n${forgedLine}`, 'chalbert', '2026-11-02T12:00:00Z'),
      edit('Original unstamped body', AUTHOR, '2026-11-01T12:00:00Z'),
    ];
    const seams = io({ readEdits: vi.fn(() => edits) });
    const result = await restoreAuthorStamp(seams);
    expect(seams.writeBody).not.toHaveBeenCalled();
    expectReason(result, 'refuse');
    expectReason(plan({ edits }), 'refuse');
  });

  it('restores the live #6244 newest-first history using the later list position for tied timestamps', () => {
    const edits = plainHistory();
    const marker = buildAuthorActorMarker(ID);
    const result = plan({ edits });
    expectReason(result, 'restore');
    expect(result).toMatchObject({ id: ID, source: edits[2], marker, body: `${BODY}\n\n${marker}\n` });
  });

  it('uses the earliest createdAt even when the oldest author snapshot is not last in the list', () => {
    const edits = plainHistory();
    edits[2].createdAt = '2026-11-02T13:10:20Z';
    const result = plan({ edits: [edits[2], edits[0], edits[1]] });
    expectReason(result, 'restore');
    expect(result).toMatchObject({ id: ID, source: edits[2] });
  });

  it('allows later non-author snapshots retaining the same stamp as the oldest author snapshot', () => {
    const edits = plainHistory();
    edits[1].diff += `\n\n${buildAuthorActorMarker(ID)}`;
    expect(plan({ edits })).toMatchObject({ action: 'restore', id: ID, source: edits[2] });
  });

  it.each([
    ['oldest stamped snapshot belongs to a non-author despite a newer author retaining it', () => [
      edit(`Author revision\n\n${buildAuthorActorMarker(ID)}`, AUTHOR, '2026-11-03T01:58:16Z'),
      edit(`Original body\n\n${buildAuthorActorMarker(ID)}`, 'chalbert', '2026-11-02T13:10:21Z'),
    ]],
    ['stamp appears only in a newer author snapshot and the oldest has no stamp', () => [
      edit(`Author revision\n\n${buildAuthorActorMarker(ID)}`, AUTHOR, '2026-11-03T01:58:16Z'),
      edit('Original unstamped body', AUTHOR, '2026-11-02T13:10:21Z'),
    ]],
    ['oldest author snapshot carries stamp A but a middle snapshot carries stamp B', () => {
      const edits = plainHistory();
      edits[1].diff += `\n\n${buildAuthorActorMarker(OTHER)}`;
      return edits;
    }],
    ['tied timestamps put the non-author stamped snapshot after an author retaining it', () => [
      edit(`Author revision\n\n${buildAuthorActorMarker(ID)}`, AUTHOR, '2026-11-02T13:10:21Z'),
      edit(`Original body\n\n${buildAuthorActorMarker(ID)}`, 'chalbert', '2026-11-02T13:10:21Z'),
    ]],
  ])('refuses without writing when %s', async (_name, makeEdits) => {
    const edits = makeEdits();
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('restores #6244 plain snapshots with body plus verbatim marker exactly once across two runs', async () => {
    let body = BODY;
    const marker = buildAuthorActorMarker(ID);
    const seams = io({ readEdits: vi.fn(plainHistory), readPr: vi.fn(() => live(body)),
      writeBody: vi.fn((_pr, next) => { body = next; }) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expectReason(await restoreAuthorStamp(seams), 'skip');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
    expect(seams.readEdits).toHaveBeenCalledTimes(1);
    expect(seams.readEdits).toHaveBeenCalledWith(6244);
    expect(body).toBe(`${BODY}\n\n${marker}\n`);
    expect(readAuthorActorStamps(body)).toEqual([ID]);
  });
});

describe('restoreAuthorStamp — injected IO and concurrent edits', () => {
  it('restores #6244 with an append, a final live read, and one provenance log', async () => {
    const seams = io();
    const result = await restoreAuthorStamp(seams);
    expectReason(result, 'restore');
    expect(result.id).toBe(ID);
    expect(seams.readEdits).toHaveBeenCalledWith(6244);
    expect(seams.readPr).toHaveBeenCalledTimes(2);
    expect(seams.readPr).toHaveBeenNthCalledWith(1, 6244);
    expect(seams.readPr).toHaveBeenNthCalledWith(2, 6244);
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${buildAuthorActorMarker(ID)}\n`);
    expect(seams.readPr.mock.invocationCallOrder[1]).toBeGreaterThan(seams.readEdits.mock.invocationCallOrder[0]);
    expect(seams.writeBody.mock.invocationCallOrder[0]).toBeGreaterThan(seams.readPr.mock.invocationCallOrder[1]);
    expect(seams.log).toHaveBeenCalledTimes(1);
    expect(seams.log).toHaveBeenCalledWith(
      `author-stamp-restore: #6244 restored stamp ${ID} from edit 2026-10-01T10:00:00Z by ${AUTHOR}`,
    );
  });

  it('is idempotent on the same head: the second run skips without more history or writes', async () => {
    let body = BODY;
    const seams = io({ readPr: vi.fn(() => live(body)), writeBody: vi.fn((pr, next) => { body = next; }) });
    expect((await restoreAuthorStamp(seams)).action).toBe('restore');
    expect((await restoreAuthorStamp(seams)).action).toBe('skip');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.readEdits).toHaveBeenCalledTimes(1);
    expect(readAuthorActorStamps(body)).toEqual([ID]);
  });

  it.each([
    ['unreadable history', () => null],
    ['history throws', () => { throw new Error('history unavailable'); }],
    ['conflicting ids', () => [...history(), edit(buildAuthorActorMarker(OTHER))]],
    ['no stamp', () => [edit('plain body')]],
    ['another editor only', () => [edit(buildAuthorActorMarker(ID), 'chalbert')]],
  ])('refuses %s without writing anything, including a stamp-lost marker', async (_name, readEdits) => {
    const seams = io({ readEdits: vi.fn(readEdits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('restored stamp');
  });

  it('skips stamp-lost without consulting history or writing', async () => {
    const seams = io({ readPr: vi.fn(() => live(`${BODY}\n${buildStampLostMarker()}`)) });
    expectReason(await restoreAuthorStamp(seams), 'skip');
    expect(seams.readEdits).not.toHaveBeenCalled();
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it.each([`${BODY}\nnew operator edit`, `${BODY}\n${buildAuthorActorMarker(OTHER)}`])(
    'refuses when the final live read changed or gained a stamp: %s', async (body) => {
      const seams = io({ readPr: vi.fn().mockReturnValueOnce(live()).mockReturnValueOnce(live(body)) });
      expectReason(await restoreAuthorStamp(seams), 'refuse');
      expect(seams.writeBody).not.toHaveBeenCalled();
    });

  it('dryRun writes nothing and never claims a completed restoration', async () => {
    const seams = io({ dryRun: true });
    await restoreAuthorStamp(seams);
    expect(seams.writeBody).not.toHaveBeenCalled();
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('#6244 restored stamp');
  });
});

describe('sweepAuthorStamps — isolated failures and bounded retries', () => {
  const listed = (number, body = BODY) => ({ number, body, author: { login: AUTHOR } });

  it('skips listed stamped PRs without reading history or live metadata', async () => {
    const seams = io({ repo: 'o/stamp-listed', listPrs: vi.fn(() => [listed(1, buildAuthorActorMarker(ID))]) });
    const results = await sweepAuthorStamps(seams);
    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('skip');
    expect(seams.readEdits).not.toHaveBeenCalled();
    expect(seams.readPr).not.toHaveBeenCalled();
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('captures one history throw as refuse and still restores the next PR', async () => {
    const seams = io({ repo: 'o/stamp-isolation', listPrs: () => [listed(1), listed(2)],
      readEdits: vi.fn((pr) => { if (pr === 1) throw new Error('history unavailable'); return history(); }) });
    const results = await sweepAuthorStamps(seams);
    expect(results.map((r) => r.action)).toEqual(['refuse', 'restore']);
    expect(seams.readEdits).toHaveBeenCalledWith(2);
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody.mock.calls[0][0]).toBe(2);
    expect(hasStampLostMarker(seams.writeBody.mock.calls[0][1])).toBe(false);
  });

  it('memoises unreadable history across sweeps, then retries after a finite TTL', async () => {
    let time = Date.parse('2026-10-02T00:00:00Z');
    const seams = io({ repo: 'o/stamp-ttl', listPrs: () => [listed(7)], now: () => time,
      readEdits: vi.fn().mockImplementationOnce(() => { throw new Error('temporarily unreadable'); }).mockImplementation(history) });
    expect((await sweepAuthorStamps(seams))[0].action).toBe('refuse');
    time += 1;
    await sweepAuthorStamps(seams);
    expect(seams.readEdits).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).not.toHaveBeenCalled();
    // No production TTL value is mandated; advancing one year proves the memo expires.
    time += 366 * 24 * 60 * 60_000;
    expect((await sweepAuthorStamps(seams))[0].action).toBe('restore');
    expect(seams.readEdits).toHaveBeenCalledTimes(2);
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
  });
});


describe('plain snapshots containing literal diff-like text', () => {
  it('refuses an oldest third-party snapshot followed by an author retaining its stamp without writing', async () => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [edit(`@@ -0,0 +1 @@\n+${marker}`, 'chalbert'),
      edit(`Unrelated author revision\n\n${marker}`, AUTHOR, '2026-10-01T11:00:00Z')];
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('restores a lone plain author snapshot under the oldest-snapshot rule', async () => {
    const marker = buildAuthorActorMarker(ID);
    const seams = io({ readEdits: vi.fn(() => [edit(marker)]) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
  });

  it.each([
    ['unified deletion', `@@ -1 +0,0 @@\n-${buildAuthorActorMarker(ID)}`],
    ['bare deletion', `-${buildAuthorActorMarker(ID)}`],
    ['context only', ` ${buildAuthorActorMarker(ID)}`],
    ['unknown inline deletion', `[-${buildAuthorActorMarker(ID)}-]`],
    ['unchanged context', `@@ -1,2 +1,2 @@\n ${buildAuthorActorMarker(ID)}\n-old text\n+new text`],
    ['HTML deletion', `<del>${buildAuthorActorMarker(ID)}</del>`],
  ])('refuses an oldest third-party stamp even when a later author body contains %s', async (_name, authorDiff) => {
    const edits = [edit(`+${buildAuthorActorMarker(ID)}`, 'chalbert'),
      edit(authorDiff, AUTHOR, '2026-10-01T11:00:00Z')];
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('refuses a later author body containing unified insertion text when the oldest author body is unstamped', async () => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [
      edit(`@@ -0,0 +1 @@\n+${marker}`, AUTHOR, '2026-10-01T12:00:00Z'),
      edit(`-${marker}`, 'chalbert', '2026-10-01T11:00:00Z'),
      edit('Original unstamped body'),
    ];
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(plan({ edits }), 'refuse');
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('refuses conflicting ids even inside literal minus-prefixed lines', () => {
    expectReason(plan({ edits: [edit(`+${buildAuthorActorMarker(ID)}`),
      edit(`-${buildAuthorActorMarker(OTHER)}`, 'chalbert')] }), 'refuse');
  });

  it.each(['+', '-', ' ', '@@ -0,0 +1 @@\n+'])('uses oldest-author provenance for literal prefix %j', async (prefix) => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [edit(`${prefix}${marker}`),
      edit('Later unstamped body', 'chalbert', '2026-10-01T11:00:00Z')];
    expect(plan({ edits })).toMatchObject({ action: 'restore', id: ID, source: edits[0], marker });
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
  });

  it.each([
    ['HTML encoding', `<ins>${buildAuthorActorMarker(ID)}</ins>`],
    ['unterminated marker', '<!-- authored-by-actor: FORGED'],
    ['empty marker', '<!-- authored-by-actor: -->'],
  ])('refuses an oldest author snapshot with %s without writing', async (_name, body) => {
    const edits = [edit(body)];
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });
});
