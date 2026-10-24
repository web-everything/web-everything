import { describe, it, expect, vi } from 'vitest';
import { enrichPrsWithCompleteComments, readCompletePrComments, readCompletePrCommentEditHistory, LIST_COMMENTS_PAGE_SIZE } from '../pr-comments-complete.mjs';
import { countGrantedRoundExtensions, buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
import { standDownOf } from '../health-smells/stood-down-prs.mjs';
import { planNoteComment } from '../reconcile-note-comment.mjs';

const repo = 'web-everything/web-everything';
const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: { login: 'web-everything' }, body: `drain park-reason spam ${i} ${'x'.repeat(10_000)}` }));
const grant = (by) => ({ author: { login: 'chalbert' }, body: buildRoundExtensionComment({ repo, pr: 4017, by, actor: 'chalbert', channel: 'test', reason: 'more', at: '2026-10-06T10:44:55Z' }) });
const note = { kind: 'round-cap-exhausted', prNumber: 4017, attempts: 6, cap: 5, text: 'PR #4017: review auto-repair rounds exhausted (6/5)' };

describe('complete comment edit history failures', () => {
  const page = (nodes, pageInfo) => JSON.stringify({ data: { repository: { pullRequest: { comments: { nodes, pageInfo } } } } });
  const first = page([{ id: 'IC_1', lastEditedAt: null }], { hasNextPage: true, endCursor: 'next' });

  it.each([
    '{}',
    page([{ id: 'IC_2' }], { hasNextPage: false }),
    page([], {}),
    page([], { hasNextPage: true, endCursor: null }),
    page([], { hasNextPage: true, endCursor: 'next' }),
    JSON.stringify({ errors: [{ message: 'denied' }], data: JSON.parse(first).data }),
  ])('refuses a partial result when a later page is malformed: %s', (later) => {
    const exec = vi.fn().mockReturnValueOnce(first).mockReturnValue(later);
    expect(() => readCompletePrCommentEditHistory(7, { repo, exec })).toThrow();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('propagates a later page transport failure', () => {
    const exec = vi.fn().mockReturnValueOnce(first).mockImplementation(() => { throw new Error('page failed'); });
    expect(() => readCompletePrCommentEditHistory(7, { repo, exec })).toThrow('page failed');
  });
});

describe('complete PR comments', () => {
  const firstPage = filler(LIST_COMMENTS_PAGE_SIZE); // >1 MiB, grants are past it
  const full = [...firstPage, ...filler(120), grant(1), grant(2)];
  const read = () => full;

  it('counts grants placed past the first page (>100 comments, >1 MiB)', () => {
    expect(JSON.stringify(full).length).toBeGreaterThan(1024 * 1024);
    expect(countGrantedRoundExtensions(firstPage, { repo, pr: 4017 })).toBe(0);
    const [pr] = enrichPrsWithCompleteComments([{ number: 4017, comments: firstPage }], { repo, readComments: read });
    expect(countGrantedRoundExtensions(pr.comments, { repo, pr: 4017 })).toBe(3);
  });

  it('does not re-post a note that exists late in the thread', () => {
    const posted = { author: { login: 'web-everything' }, body: planNoteComment(note, []).body };
    const truncated = { number: 4017, comments: firstPage };
    expect(planNoteComment(note, truncated.comments).alreadyPosted).toBe(false);
    const [pr] = enrichPrsWithCompleteComments([truncated], { repo, readComments: () => [...full, posted] });
    expect(planNoteComment(note, pr.comments).alreadyPosted).toBe(true);
  });

  it('a failed read never counts as zero grants: the PR is skipped, not decided on', () => {
    const errors = [];
    const out = enrichPrsWithCompleteComments([{ number: 1, comments: [] }, { number: 4017, comments: firstPage }], {
      repo, readComments: () => { throw new Error('boom'); }, onError: (p) => errors.push(p.number),
    });
    expect(out.map((p) => p.number)).toEqual([1]);
    expect(errors).toEqual([4017]);
  });

  it.each([0, LIST_COMMENTS_PAGE_SIZE - 1])('skips a PR when the complete read returns only %i comments, fewer than the listed page', count => {
    const onError = vi.fn();
    const short = { number: 1, comments: [] };
    const incomplete = { number: 4017, comments: firstPage };
    const out = enrichPrsWithCompleteComments([short, incomplete], {
      repo, readComments: () => firstPage.slice(0, count), onError,
    });
    expect(out).toEqual([short]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(incomplete, expect.any(Error));
  });

  it('short threads are untouched and never re-read', () => {
    const prs = [{ number: 2, comments: filler(3) }];
    expect(enrichPrsWithCompleteComments(prs, { readComments: () => { throw new Error('no'); } })).toEqual(prs);
  });

  it('reads through the safe reader with a large buffer and surfaces failures', () => {
    const seen = [];
    const exec = (f, a, o) => { seen.push(o.maxBuffer); return 'hi\t2026-01-01T00:00:00Z\tchalbert\tIC_1\n'; };
    const c = readCompletePrComments(7, { repo, exec });
    expect(c[0].author.login).toBe('chalbert');
    expect(seen[0]).toBeGreaterThanOrEqual(1024 * 1024);
    expect(() => readCompletePrComments(7, { repo, exec: () => { throw new Error('ENOBUFS'); } })).toThrow();
  });
});


it('annotates short and complete threads through the injected reader', () => {
  const seen = [];
  const annotate = (pr) => { seen.push(pr.number); return { ...pr, annotated: true }; };
  const out = enrichPrsWithCompleteComments([{ number: 1, comments: [] }, { number: 2, comments: filler(100) }], { annotate, readComments: () => filler(100) });
  expect(seen).toEqual([1, 2]);
  expect(out.every((pr) => pr.annotated)).toBe(true);
});
it('lapses a #5045 short thread before the reconciler reads it', () => {
  const body = '🛑 conveyor fix — stood down, human judgment needed\nHead: 27dfad20a631ff4a3ea0d60fe8da01f6e18fe07d.\n<!-- stand-down reason=fix-loop-exhausted -->';
  const [pr] = enrichPrsWithCompleteComments([{ number: 5045, headRefOid: '922a19a18cd6f25f6838b98b79127277247bd5bc', comments: [{ body, author: { login: 'web-everything' } }] }]);
  expect(pr.comments[0].standDownLapsed?.toHead).toBe(pr.headRefOid);
  expect(countUnresolvedStandDowns(pr.comments)).toBe(0);
  expect(standDownOf({ ...pr, labels: ['review-status:stood-down'] })).toBeNull();
});

it('builds red-main context once, lazily, including markers on complete threads', () => {
  const head = 'a'.repeat(40);
  const comment = { body: `🛑 conveyor fix — stood down, human judgment needed\n<!-- stand-down reason=fix-loop-exhausted head=${head} -->`, author: { login: 'web-everything' } };
  const readRows = vi.fn(() => [5195, 5196].flatMap(pr => ['ci-heal', 'park'].map(kind => ({
    v: 1, repo: 'we', pr, head, kind, reason: 'budget', at: '2026-10-13T22:04:33Z',
  }))));
  const readConfig = vi.fn(() => ({ hold: true, maxSessions: 3, windowHours: 6, redMainDiscount: 'on',
    redMainWindows: [{ start: '2026-10-13T21:33:48Z', end: '2026-10-13T23:32:06Z' }] }));
  const options = { repo, readRows, readConfig, readComments: () => [...filler(100), comment] };
  enrichPrsWithCompleteComments([{ number: 1, comments: [] }], options);
  expect(readRows).not.toHaveBeenCalled();
  const result = enrichPrsWithCompleteComments([
    { number: 5195, headRefOid: head, comments: [comment] },
    { number: 5196, headRefOid: head, comments: filler(100) },
  ], options);
  expect(readRows).toHaveBeenCalledTimes(1);
  expect(readConfig).toHaveBeenCalledTimes(1);
  expect(result.every(pr => countUnresolvedStandDowns(pr.comments) === 0)).toBe(true);
  for (const failure of ['readRows', 'readConfig']) {
    const [held] = enrichPrsWithCompleteComments([{ number: 5195, headRefOid: head, comments: [comment] }], {
      ...options, [failure]: () => { throw new Error('unreadable'); },
    });
    expect(countUnresolvedStandDowns(held.comments)).toBe(1);
  }
});
