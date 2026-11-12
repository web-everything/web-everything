import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGhSync } from '../gh-throttle.mjs';
import { planStampRestore, readAuthorStampEdits, restoreAuthorStamp, sweepAuthorStamps } from '../author-stamp-restore.mjs';
import { buildAuthorActorMarker, buildStampLostMarker, decideClearerIndependence, hasStampLostMarker, readAuthorActorStamps } from '../review-independence.mjs';

const ID = '01f39b97-274a-4078-8eeb-e7f8d6008673';
const OTHER = 'ffffffff-1111-2222-3333-444444444444';
const AUTHOR = 'plateau-worker';
const BODY = 'Resolve the review issue.\n\nOperator clarification.';
const edit = (diff, login = AUTHOR, createdAt = '2026-10-01T10:00:00Z', __typename = login === AUTHOR ? 'Bot' : 'User') => ({
  diff, editor: { __typename, login }, createdAt,
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
const live = (body = BODY) => ({ state: 'OPEN', body, author: { login: `app/${AUTHOR}` } });
const plan = (overrides = {}) => planStampRestore({ state: 'OPEN', body: BODY, authorLogin: `app/${AUTHOR}`, edits: history(), ...overrides });
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
    expect(plan({ authorLogin: 'APP/PLATEAU-WORKER' })).toMatchObject({ action: 'restore', id: ID });
  });

  it.each(['app/plateau-worker', 'APP/PLATEAU-WORKER'])(
    'restores a stamp supplied by the bot author %s', (authorLogin) => {
      expect(plan({ authorLogin })).toMatchObject({ action: 'restore', id: ID });
    });

  it.each(['app/other', 'app/', '', 'app/app/plateau-worker', 'plateau-worker[bot]', ' plateau-worker'])(
    'refuses a missing or nonmatching bot author %s', (authorLogin) => {
      expectReason(plan({ authorLogin }), 'refuse');
    });

  it.each([
    ['User impersonating a bot', 'app/plateau-worker', 'User'],
    ['Bot impersonating a user', 'plateau-worker', 'Bot'],
    ['missing editor type', 'app/plateau-worker', undefined],
    ['unknown editor type', 'app/plateau-worker', 'Organization'],
  ])('refuses %s without writing', async (_name, authorLogin, __typename) => {
    const edits = history();
    edits[0].editor.__typename = __typename;
    const seams = io({ readPr: vi.fn(() => ({ ...live(), author: { login: authorLogin } })),
      readEdits: vi.fn(() => edits) });
    expectReason(plan({ authorLogin, edits }), 'refuse');
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('restores a matching User editor and plain author case-insensitively', () => {
    const edits = [edit(buildAuthorActorMarker(ID), 'Chalbert')];
    expect(plan({ authorLogin: 'CHALBERT', edits })).toMatchObject({ action: 'restore', id: ID });
  });

  it('requests the editor identity type alongside its login', () => {
    const exec = vi.fn(() => JSON.stringify({ data: { repository: { pullRequest: {
      userContentEdits: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
    } } } }));
    expect(readAuthorStampEdits(6244, { repo: 'o/r', exec })).toEqual([]);
    expect(exec.mock.calls[0][1].find((arg) => arg.startsWith('query=')))
      .toContain('editor{__typename login}');
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

  it.each([{ edits: [] }, { edits: [edit('never stamped')] }, { edits: [edit('never stamped', 'chalbert')] }])(
    'marks complete history with zero stamps as stamp-lost, never as a restored id: %j', ({ edits }) => {
      const result = plan({ edits });
      expectReason(result, 'mark-lost');
      expect(result.id).toBeUndefined();
      expect(result.body).toBe(`${BODY}\n\n${buildStampLostMarker()}\n`);
      expect(hasStampLostMarker(result.body)).toBe(true);
      expect(readAuthorActorStamps(result.body)).toEqual([]);
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
  it.each([
    ['word-diff deletion', `[-${buildAuthorActorMarker(ID)}-]`],
    ['word-diff insertion', `{+${buildAuthorActorMarker(ID)}+}`],
    ['inline prefix', `prefix text ${buildAuthorActorMarker(ID)}`],
    ['inline suffix', `${buildAuthorActorMarker(ID)} trailing text`],
    ['backtick fenced code', `\`\`\`html\n${buildAuthorActorMarker(ID)}\n\`\`\``],
    ['tilde fenced code', `~~~html\n${buildAuthorActorMarker(ID)}\n~~~`],
    ['blockquote', `> ${buildAuthorActorMarker(ID)}`],
    ['two different ids', `${buildAuthorActorMarker(ID)}\n${buildAuthorActorMarker(OTHER)}`],
    ['two agreeing markers on one line', `${buildAuthorActorMarker(ID)} ${buildAuthorActorMarker(ID)}`],
    ['extra stamp text inside a marker', `<!-- authored-by-actor: ${ID} authored-by-actor: ${ID} -->`],
    ['tab indentation', `\t${buildAuthorActorMarker(ID)}`],
    ['multiline marker', `<!--\nauthored-by-actor: ${ID} -->`],
    ...['[-', '-]', '{+', '+}'].map((token) => [
      `word-diff token ${token} away from a standalone marker`, `Body ${token}\n\n${buildAuthorActorMarker(ID)}\n`,
    ]),
  ])('refuses an otherwise eligible oldest author snapshot with %s and writes nothing', async (_name, diff) => {
    const edits = [edit(diff), edit(BODY, 'chalbert', '2026-10-01T11:00:00Z')];
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
    expectReason(plan({ edits }), 'refuse');
  });

  it.each(['', ' \t'])('restores a pr-land standalone final marker with trailing whitespace %j', async (trailing) => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [edit(`Original body\n\n${marker}${trailing}\n`)];
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
  });

  it.each([
    ['inline marker', `prefix ${buildAuthorActorMarker(ID)}`],
    ['malformed occurrence beside a valid marker', `${buildAuthorActorMarker(ID)}\nauthored-by-actor: broken`],
    ['word-diff token without any marker', 'Revised body [-removed-]'],
    ['unclosed code fence', `\`\`\`html\n${buildAuthorActorMarker(ID)}`],
  ])('refuses the whole history for a later non-author snapshot with %s without writing', async (_name, diff) => {
    const edits = [...history(), edit(diff, 'chalbert', '2026-10-02T10:00:00Z')];
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
    expectReason(plan({ edits }), 'refuse');
  });

  it.each(['```', '~~~'])('restores a standalone marker after a closed %s code fence', async (fence) => {
    const marker = buildAuthorActorMarker(ID);
    const seams = io({ readEdits: vi.fn(() => [edit(`${fence}text\nexample\n${fence}\n\n${marker}\n`)]) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
  });

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
    // Planning read + pre-write re-read on the restore run; the skip run reads no history.
    expect(seams.readEdits).toHaveBeenCalledTimes(2);
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
    // Planning read + pre-write re-read on the restore run; the skip run reads no history.
    expect(seams.readEdits).toHaveBeenCalledTimes(2);
    expect(readAuthorActorStamps(body)).toEqual([ID]);
  });

  it.each([
    ['unreadable history', () => null],
    ['history throws', () => { throw new Error('history unavailable'); }],
    ['conflicting ids', () => [...history(), edit(buildAuthorActorMarker(OTHER))]],
    ['another editor only', () => [edit(buildAuthorActorMarker(ID), 'chalbert')]],
  ])('refuses %s without writing anything, including a stamp-lost marker', async (_name, readEdits) => {
    const seams = io({ readEdits: vi.fn(readEdits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('restored stamp');
  });

  it('writes the stamp-lost marker once for complete zero-stamp history, never inventing an id', async () => {
    const seams = io({ readEdits: vi.fn(() => [edit('plain body', 'chalbert')]) });
    const result = await restoreAuthorStamp(seams);
    expectReason(result, 'mark-lost');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${buildStampLostMarker()}\n`);
    expect(readAuthorActorStamps(seams.writeBody.mock.calls[0][1])).toEqual([]);
    expect(seams.log.mock.calls.flat().join('\n')).toContain('stamp-lost');
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('restored stamp');
  });

  it('a marked zero-stamp PR is never independent, for any clearer, with or without the PR date', () => {
    const { body } = plan({ edits: [] });
    for (const prCreatedAt of [undefined, '2020-01-01T00:00:00Z', '2026-11-01T00:00:00Z']) {
      const verdict = decideClearerIndependence({ authorId: readAuthorActorStamps(body)[0], clearerId: 'some-session',
        prCreatedAt, stampLostMarked: hasStampLostMarker(body) });
      expect(verdict.independent).toBe(false);
      expect(verdict.status).toBe('stamp-lost');
    }
  });

  it('does not mark stamp-lost when the history changes before the write', async () => {
    const readEdits = vi.fn().mockReturnValueOnce([edit('plain body')]).mockReturnValueOnce([edit('plain body'), edit(buildAuthorActorMarker(ID))]);
    const seams = io({ readEdits });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
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

  // Red-team break (#6409): another session stamps B then removes it, returning the body to its exact
  // text. Identical text is not unchanged evidence: the history read again before the write must match.
  it.each([
    ['a conflicting stamp added then removed', () => [
      edit(BODY, 'chalbert', '2026-10-01T14:00:00Z'),
      edit(`${BODY}\n\n${buildAuthorActorMarker(OTHER)}`, 'chalbert', '2026-10-01T13:00:00Z'),
      ...history(),
    ]],
    ['an agreeing revision that restores the same text', () => [edit(BODY, 'chalbert', '2026-10-01T13:00:00Z'), ...history()]],
    ['a rewritten snapshot of the same length', () => [edit(`Original body\n\n${buildAuthorActorMarker(OTHER)}`), ...history().slice(1)]],
    ['an unreadable re-read', () => null],
    ['a re-read that throws', () => { throw new Error('history unavailable'); }],
  ])('refuses when the history changed before write (%s) even though the body text is identical', async (_name, later) => {
    const seams = io({ readEdits: vi.fn().mockReturnValueOnce(history()).mockImplementationOnce(later) });
    const result = await restoreAuthorStamp(seams);
    expectReason(result, 'refuse');
    expect(seams.readEdits).toHaveBeenCalledTimes(2);
    expect(seams.readEdits.mock.invocationCallOrder[1]).toBeGreaterThan(seams.readPr.mock.invocationCallOrder[1]);
    expect(seams.writeBody).not.toHaveBeenCalled();
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('restored stamp');
  });

  it('dryRun writes nothing and never claims a completed restoration', async () => {
    const seams = io({ dryRun: true });
    await restoreAuthorStamp(seams);
    expect(seams.writeBody).not.toHaveBeenCalled();
    expect(seams.log.mock.calls.flat().join('\n')).not.toContain('#6244 restored stamp');
  });
});

describe('sweepAuthorStamps — isolated failures and bounded retries', () => {
  const listed = (number, body = BODY) => ({ number, body, author: { login: `app/${AUTHOR}` } });

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
    expect(seams.readEdits).toHaveBeenCalledTimes(3); // + planning read and pre-write re-read
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

  it.each(['+', '-', '@@ -0,0 +1 @@\n+'])('refuses delta-looking marker prefix %j without writing', async (prefix) => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [edit(`${prefix}${marker}`),
      edit('Later unstamped body', 'chalbert', '2026-10-01T11:00:00Z')];
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('refuses a plain body with a space-indented marker on its own line without writing', async () => {
    const marker = buildAuthorActorMarker(ID);
    const edits = [edit(`Original body\n ${marker}`),
      edit('Later unstamped body', 'chalbert', '2026-10-01T11:00:00Z')];
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it.each([
    ['deletion-only oldest author snapshot', () => [edit(`@@ -1 +0,0 @@\n-${buildAuthorActorMarker(OTHER)}`)]],
    ['hunk header without a prefixed marker', () => [edit(`@@ -1 +1 @@\n${buildAuthorActorMarker(ID)}`)]],
    ['later plus-prefixed marker', () => [...history(), edit(`+${buildAuthorActorMarker(ID)}`, 'chalbert', '2026-10-02T10:00:00Z')]],
    ['later indented minus-prefixed marker', () => [...history(), edit(`  - removed ${buildAuthorActorMarker(ID)}`, 'chalbert', '2026-10-02T10:00:00Z')]],
    ['later unstamped hunk', () => [...history(), edit('@@ -1 +1 @@\n-old\n+new', 'chalbert', '2026-10-02T10:00:00Z')]],
    ['later HTML snapshot', () => [...history(), edit('<p>new body</p>', 'chalbert', '2026-10-02T10:00:00Z')]],
  ])('refuses the whole history for %s without writing', async (_name, makeEdits) => {
    const edits = makeEdits();
    expectReason(plan({ edits }), 'refuse');
    const seams = io({ readEdits: vi.fn(() => edits) });
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
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

// PR #6409 review: each clause of the "history is complete" condition and each bound gets its own named test.
describe('readAuthorStampEdits — complete, bounded history only', () => {
  const connection = (nodes, extra = {}) => ({ totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes, ...extra });
  const reply = (userContentEdits) => JSON.stringify({ data: { repository: { pullRequest: { userContentEdits } } } });
  const stamped = (n) => Array.from({ length: n }, (_, i) =>
    edit(`Original body\n\n${buildAuthorActorMarker(ID)}`, AUTHOR, new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60_000).toISOString()));
  // Real readAuthorStampEdits behind restoreAuthorStamp: only the gh transport is injected.
  const transportSeams = (userContentEdits) => ({ pr: 6244, repo: 'o/r', readPr: vi.fn(() => live()),
    exec: vi.fn(() => reply(userContentEdits)), writeBody: vi.fn(), log: vi.fn() });

  it.each([
    ['a next page exists (hasNextPage:true)', () => connection(history(), { pageInfo: { hasNextPage: true } })],
    ['hasNextPage is missing', () => connection(history(), { pageInfo: {} })],
    ['hasNextPage is null', () => connection(history(), { pageInfo: { hasNextPage: null } })],
    ['pageInfo is missing', () => connection(history(), { pageInfo: undefined })],
    ['totalCount exceeds the nodes returned (truncated page)', () => connection(history(), { totalCount: 4 })],
    ['totalCount is below the nodes returned', () => connection(history(), { totalCount: 2 })],
    ['totalCount is missing', () => connection(history(), { totalCount: undefined })],
    ['totalCount is not an integer', () => connection(history(), { totalCount: '3' })],
    ['more than 100 nodes arrive in one reply', () => connection(stamped(101))],
  ])('refuses incomplete history when %s, and restore writes nothing', async (_name, make) => {
    expect(() => readAuthorStampEdits(6244, { repo: 'o/r', exec: () => reply(make()) }))
      .toThrow(/incomplete edit history/);
    const seams = transportSeams(make());
    const result = await restoreAuthorStamp(seams);
    expectReason(result, 'refuse');
    expect(result.reason).toMatch(/incomplete edit history/);
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('refuses a reply carrying GraphQL errors beside an otherwise complete connection', async () => {
    const withErrors = JSON.stringify({ errors: [{ message: 'partial' }],
      data: { repository: { pullRequest: { userContentEdits: connection(history()) } } } });
    expect(() => readAuthorStampEdits(6244, { repo: 'o/r', exec: () => withErrors })).toThrow(/incomplete edit history/);
    const seams = { ...transportSeams(connection(history())), exec: vi.fn(() => withErrors) };
    expectReason(await restoreAuthorStamp(seams), 'refuse');
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('restores through the same transport when the history is complete (control for the refusals above)', async () => {
    const seams = transportSeams(connection(history()));
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledTimes(1);
  });

  it('requests at most 100 edit snapshots in one call with an 8 MiB buffer', () => {
    const exec = vi.fn(() => reply(connection([])));
    readAuthorStampEdits(6244, { repo: 'owner/name', exec });
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args.find((a) => a.startsWith('query='))).toContain('userContentEdits(first:100)');
    expect(args).toEqual(expect.arrayContaining(['owner=owner', 'name=name', 'number=6244']));
    expect(options).toEqual(expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }));
  });

  it.each([
    ['empty repo', '', 6244], ['repo without owner', 'name', 6244], ['three-part repo', 'o/r/x', 6244],
    ['blank owner', ' /r', 6244], ['blank name', 'o/ ', 6244], ['non-string repo', null, 6244],
    ['zero PR', 'o/r', 0], ['negative PR', 'o/r', -1], ['fractional PR', 'o/r', 1.5],
    ['non-numeric PR', 'o/r', 'abc'], ['leading-zero PR', 'o/r', '01'], ['injected PR', 'o/r', '1 -f x=y'],
  ])('refuses a %s before any request', (_name, repo, pr) => {
    const exec = vi.fn();
    expect(() => readAuthorStampEdits(pr, { repo, exec })).toThrow(/invalid repository or PR number/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('plans from exactly 100 snapshots but refuses 101 handed in by another reader', () => {
    expect(plan({ edits: stamped(100) })).toMatchObject({ action: 'restore', id: ID });
    const result = plan({ edits: stamped(101) });
    expectReason(result, 'refuse');
    expect(result.reason).toMatch(/snapshot bound/);
  });
});

describe('sweepAuthorStamps — listing bounds', () => {
  const listed = (number, body = buildAuthorActorMarker(ID)) => ({ number, body, author: { login: `app/${AUTHOR}` } });

  it('throws on a listing that hit the 100-PR cap, before any per-PR read', () => {
    const seams = io({ repo: 'o/stamp-cap', listPrs: () => Array.from({ length: 100 }, (_, i) => listed(i + 1, BODY)) });
    expect(() => sweepAuthorStamps(seams)).toThrow(/capped PR listing/);
    expect(seams.readPr).not.toHaveBeenCalled();
    expect(seams.writeBody).not.toHaveBeenCalled();
  });

  it('sweeps a 99-PR listing of stamped PRs with skips only', () => {
    const seams = io({ repo: 'o/stamp-99', listPrs: () => Array.from({ length: 99 }, (_, i) => listed(i + 1)) });
    const results = sweepAuthorStamps(seams);
    expect(results).toHaveLength(99);
    expect(results.every((r) => r.action === 'skip')).toBe(true);
    expect(seams.readPr).not.toHaveBeenCalled();
  });

  it('lists open PRs with a 100 limit and an 8 MiB buffer, so the cap check matches the request', () => {
    const exec = vi.fn(() => '[]');
    expect(sweepAuthorStamps({ repo: 'o/stamp-default-list', exec })).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args.slice(0, 2)).toEqual(['pr', 'list']);
    expect(args[args.indexOf('--limit') + 1]).toBe('100');
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--repo') + 1]).toBe('o/stamp-default-list');
    expect(options).toEqual(expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }));
  });

  it('bounds the refusal memo: the oldest refusal is evicted after 1000 newer ones', () => {
    const time = Date.parse('2030-01-01T00:00:00Z');
    const seams = io({ repo: 'o/stamp-evict', listPrs: () => [listed(1, BODY)], now: () => time,
      readEdits: vi.fn().mockImplementationOnce(() => { throw new Error('unreadable'); }).mockImplementation(history) });
    expect(sweepAuthorStamps(seams)[0].action).toBe('refuse');
    expect(sweepAuthorStamps(seams)[0].action).toBe('refuse');
    expect(seams.readEdits).toHaveBeenCalledTimes(1); // memoised
    // 11 sweeps x 99 distinct invalid-number refusals = 1089 newer entries, each read-free.
    for (let s = 0; s < 11; s += 1) {
      sweepAuthorStamps({ repo: 'o/stamp-evict-fill', now: () => time,
        listPrs: () => Array.from({ length: 99 }, (_, i) => listed(0, `fill-${s}-${i}`)) });
    }
    expect(sweepAuthorStamps(seams)[0].action).toBe('restore');
    expect(seams.readEdits).toHaveBeenCalledTimes(3); // + planning read and pre-write re-read
  });

  it.each([null, {}, 'prs'])('throws on an unreadable listing: %j', (prs) => {
    expect(() => sweepAuthorStamps(io({ repo: 'o/stamp-bad', listPrs: () => prs }))).toThrow(/unreadable or capped/);
  });

  it.each([0, -1, 1.5, '7', null])('refuses listed PR number %j without reading or writing', (number) => {
    const seams = io({ repo: `o/stamp-num-${String(number)}`, listPrs: () => [listed(number, BODY)] });
    const [result] = sweepAuthorStamps(seams);
    expectReason(result, 'refuse');
    expect(result.reason).toMatch(/invalid listed PR number/);
    expect(seams.readPr).not.toHaveBeenCalled();
    expect(seams.writeBody).not.toHaveBeenCalled();
  });
});

describe('restoreAuthorStamp — the historical marker is written verbatim', () => {
  it('preserves a noncanonical historical marker byte-for-byte', async () => {
    const marker = `<!--authored-by-actor:\t${ID}   -->`;
    expect(marker).not.toBe(buildAuthorActorMarker(ID));
    expect(readAuthorActorStamps(marker)).toEqual([ID]);
    const seams = io({ readEdits: vi.fn(() => [edit(`Original body\n\n${marker}  `)]) });
    expectReason(await restoreAuthorStamp(seams), 'restore');
    expect(seams.writeBody).toHaveBeenCalledWith(6244, `${BODY}\n\n${marker}\n`);
  });

  it('writes through gh pr edit on stdin with the stamp-guard bypass scoped to that one call', () => {
    const exec = vi.fn(() => '');
    expectReason(restoreAuthorStamp({ ...io(), writeBody: undefined, repo: 'o/r', exec }), 'restore');
    expect(exec).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = exec.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['pr', 'edit', '6244', '--repo', 'o/r', '--body-file', '-']);
    expect(options.input).toBe(`${BODY}\n\n${buildAuthorActorMarker(ID)}\n`);
    expect(options.env.PR_BODY_STAMP_OK).toBe('1');
    expect(options.maxBuffer).toBe(8 * 1024 * 1024);
    expect(options.env).not.toBe(process.env); // a copy: the bypass never leaks into this process
  });
});

// Red-team break on 610291eb8: with the smoke read memo on, the pre-write PR read was served from the
// memo, so an operator edit made during the history read was overwritten. Every restoration read is live.
describe('restoration evidence bypasses the gh read memo', () => {
  const made = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // The real gh-throttle memo in front of a fake gh: each `pr view` returns the next queued body.
  function realThrottle(bodies, { listing = [] } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'stamp-restore-memo-'));
    made.push(dir);
    const memo = join(dir, 'memo');
    mkdirSync(memo);
    vi.stubEnv('WE_GH_READ_MEMO_DIR', memo);
    vi.stubEnv('WE_GH_PERSONAL_READS', '0');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ bodies, views: 0, lists: 0, graphql: 0, writes: [] }));
    const bin = join(dir, 'fake-gh');
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const s = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const a = process.argv.slice(2);
let out = '';
if (a[0] === 'pr' && a[1] === 'view') {
  const body = s.bodies[Math.min(s.views, s.bodies.length - 1)];
  s.views += 1;
  out = JSON.stringify({ state: 'OPEN', body, author: { login: 'app/${AUTHOR}' } });
} else if (a[0] === 'pr' && a[1] === 'list') {
  s.lists += 1;
  out = JSON.stringify(${JSON.stringify(listing)});
} else if (a[0] === 'api' && a[1] === 'graphql') {
  s.graphql += 1;
  const nodes = ${JSON.stringify(history())};
  out = JSON.stringify({ data: { repository: { pullRequest: { userContentEdits: {
    totalCount: nodes.length, pageInfo: { hasNextPage: false }, nodes } } } } });
} else if (a[0] === 'pr' && a[1] === 'edit') {
  s.writes.push(fs.readFileSync(0, 'utf8'));
}
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(s));
process.stdout.write(out);
`);
    chmodSync(bin, 0o755);
    const exec = (file, args, opts = {}) => runGhSync(args, { ...opts, throttle: {
      ...opts.throttle, bin, lockRoot: join(dir, 'locks'), logPath: join(dir, 'calls.jsonl'), maxAttempts: 1,
      env: { ...(opts.throttle?.env ?? process.env), GH_TOKEN: 'test' } } });
    return { exec, read: () => JSON.parse(readFileSync(state, 'utf8')) };
  }

  it('refuses without writing when an operator edits the body during the history read, memo on', () => {
    const operatorEdit = `${BODY}\n\nOperator edit made while the history was being read.`;
    const gh = realThrottle([BODY, operatorEdit]);
    const result = restoreAuthorStamp({ pr: 6244, repo: 'o/stamp-restore', exec: gh.exec, log: vi.fn() });
    expectReason(result, 'refuse');
    expect(result.reason).toMatch(/changed before write/);
    expect(gh.read().views).toBe(2); // the pre-write read reached GitHub, not the memo
    expect(gh.read().writes).toEqual([]);
  });

  it('reads the history live on every call, memo on', () => {
    const gh = realThrottle([BODY]);
    readAuthorStampEdits(6244, { repo: 'o/stamp-restore', exec: gh.exec });
    readAuthorStampEdits(6244, { repo: 'o/stamp-restore', exec: gh.exec });
    expect(gh.read().graphql).toBe(2);
  });

  it('lists PRs live on every sweep, memo on', () => {
    const listing = [{ number: 6244, body: buildAuthorActorMarker(ID), author: { login: `app/${AUTHOR}` } }];
    const gh = realThrottle([BODY], { listing });
    sweepAuthorStamps({ repo: 'o/stamp-restore', exec: gh.exec });
    sweepAuthorStamps({ repo: 'o/stamp-restore', exec: gh.exec });
    expect(gh.read().lists).toBe(2);
  });

  it('strips the memo from both environments on every default GitHub read and write', () => {
    vi.stubEnv('WE_GH_READ_MEMO_DIR', 'memo-dir');
    const exec = vi.fn((file, args) => {
      if (args[1] === 'view') return JSON.stringify(live());
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { userContentEdits: {
        totalCount: 3, pageInfo: { hasNextPage: false }, nodes: history() } } } } });
      if (args[1] === 'list') return JSON.stringify([{ number: 6244, body: BODY, author: { login: `app/${AUTHOR}` } }]);
      return '';
    });
    sweepAuthorStamps({ repo: 'o/stamp-restore', exec, log: vi.fn() });
    expect(exec.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ['pr', 'list'], ['pr', 'view'], ['api', 'graphql'], ['pr', 'view'], ['api', 'graphql'], ['pr', 'edit']]);
    for (const [, , opts] of exec.mock.calls) {
      expect(opts.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
      expect(opts.throttle.env).not.toHaveProperty('WE_GH_READ_MEMO_DIR');
    }
    expect(process.env.WE_GH_READ_MEMO_DIR).toBe('memo-dir');
  });
});
