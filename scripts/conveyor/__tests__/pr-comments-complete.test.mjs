import { describe, it, expect, vi } from 'vitest';
import { enrichPrsWithCompleteComments, readCompletePrComments, readCompletePrCommentEditHistory, LIST_COMMENTS_PAGE_SIZE } from '../pr-comments-complete.mjs';
import { countGrantedRoundExtensions, buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { countUnresolvedStandDowns } from '../reconcile-core.mjs';
import { standDownOf } from '../health-smells/stood-down-prs.mjs';
import { planNoteComment } from '../reconcile-note-comment.mjs';
import { buildClearedHumanMarker, buildReviewedShaMarker } from '../../lib/review-escalation.mjs';
import * as prCommentsList from '../pr-comments-list.mjs';

const repo = 'web-everything/web-everything';
const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: { login: 'web-everything' }, body: `drain park-reason spam ${i} ${'x'.repeat(10_000)}` }));
const grant = (by) => ({ author: { login: 'chalbert' }, body: buildRoundExtensionComment({ repo, pr: 4017, by, actor: 'chalbert', channel: 'test', reason: 'more', at: '2026-10-06T10:44:55Z' }) });
const note = { kind: 'round-cap-exhausted', prNumber: 4017, attempts: 6, cap: 5, text: 'PR #4017: review auto-repair rounds exhausted (6/5)' };

describe('complete PR comment count proof', () => {
  const countResponse = totalCount => JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount } } } } });
  const restOutput = ids => ids.map(id => `discussion\t2026-01-01T00:00:00Z\tchalbert\t${id ?? ''}\n`).join('');
  const transport = (ids, response = countResponse(ids.length)) => vi.fn()
    .mockReturnValueOnce(restOutput(ids)).mockReturnValueOnce(response);

  it.each([0, 1, 100, 201])('accepts %i comments only with an equal GraphQL count through the same exec', count => {
    const ids = Array.from({ length: count }, (_, i) => `IC_${i}`);
    const exec = transport(ids);
    expect(readCompletePrComments(7, { repo, exec }).map(c => c.id)).toEqual(ids);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toContain(`repos/${repo}/issues/7/comments`);
    const [file, args, options] = exec.mock.calls[1];
    expect(file).toBe('gh');
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toEqual(expect.arrayContaining(['owner=web-everything', 'name=web-everything', 'n=7']));
    expect(args.find(a => a.startsWith('query='))).toMatch(/repository\(owner:\$owner,name:\$name\)\{pullRequest\(number:\$n\)\{comments\{totalCount\}\}\}/);
    expect(options.maxBuffer).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('rejects a 300-comment thread silently read as 200', () => {
    const exec = transport(Array.from({ length: 200 }, (_, i) => `IC_${i}`), countResponse(300));
    expect(() => readCompletePrComments(7, { repo, exec })).toThrow();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing body', { body: undefined }], ['null body', { body: null }], ['non-string body', { body: 42 }],
    ['missing author', { author: undefined }], ['null author', { author: null }],
    ['missing login', { author: {} }], ['empty login', { author: { login: '' } }],
    ['blank login', { author: { login: ' ' } }], ['non-string login', { author: { login: 42 } }],
    ['empty user login', { author: undefined, user: { login: '' } }],
  ])('rejects a parsed comment with %s despite an equal count and unique ids', (_name, fields) => {
    // TSV cannot distinguish a missing body from an empty string; exercise verification after parsing.
    const read = vi.spyOn(prCommentsList, 'defaultListPrComments').mockReturnValueOnce([
      { id: 'IC_1', body: 'valid discussion', author: { login: 'chalbert' } },
      { id: 'IC_2', body: 'discussion', author: { login: 'chalbert' }, ...fields },
    ]);
    try {
      expect(() => readCompletePrComments(7, { repo, exec: () => countResponse(2) })).toThrow(/string body|author login/);
    } finally {
      read.mockRestore();
    }
  });

  it('rejects a paginated TSV comment with a missing author despite an equal count and unique id', () => {
    const exec = vi.fn().mockReturnValueOnce('discussion\t2026-01-01T00:00:00Z\t\tIC_1\n')
      .mockReturnValueOnce(countResponse(1));
    expect(() => readCompletePrComments(7, { repo, exec })).toThrow(/author login/);
  });

  it.each([['duplicate ids', ['IC_1', 'IC_1']], ['missing id', [null]], ['blank id', [' ']]])('rejects %s despite an equal count', (_name, ids) => {
    expect(() => readCompletePrComments(7, { repo, exec: transport(ids) })).toThrow();
  });

  it.each([
    ['missing count', '{}'], ['invalid JSON', 'not json'],
    ...[null, '1', 1.5, -1, 0, 2].map(count => [`invalid or unequal count ${count}`, countResponse(count)]),
    ['GraphQL errors with partial data', JSON.stringify({ ...JSON.parse(countResponse(1)), errors: [{ message: 'denied' }] })],
    ['malformed GraphQL errors', JSON.stringify({ ...JSON.parse(countResponse(1)), errors: {} })],
  ])('fails closed on %s', (_name, response) => {
    expect(() => readCompletePrComments(7, { repo, exec: transport(['IC_1'], response) })).toThrow();
  });

  it('propagates a GraphQL transport failure after a successful paged read', () => {
    const exec = vi.fn().mockReturnValueOnce(restOutput(['IC_1'])).mockImplementation(() => { throw new Error('graphql failed'); });
    expect(() => readCompletePrComments(7, { repo, exec })).toThrow('graphql failed');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, '', 'owner', '/repo', 'owner/', 'owner/repo/extra', 'owner/repo\n', 'owner name/repo', 'owner/..', {}])('requires an explicit valid repository: %j', repo => {
    const exec = transport(['IC_1']);
    expect(() => readCompletePrComments(7, { repo, exec })).toThrow(/explicit valid.*repository/);
    expect(exec).not.toHaveBeenCalled();
  });
});

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

  it.each([
    ['Web-Everything', 'web-everything[bot]'],
    ['Web-Everything[bot]', 'web-everything'],
  ])('accepts a complete 201-comment bot thread with GraphQL %s and REST %s', (listedLogin, fullLogin) => {
    const comments = Array.from({ length: 201 }, (_, i) => ({
      id: `IC_bot_${i}`, body: `bot discussion ${i}`, user: { login: fullLogin },
    }));
    const listed = comments.slice(0, LIST_COMMENTS_PAGE_SIZE).map(({ id, body }) => ({
      id, body, author: { login: listedLogin },
    }));
    const onError = vi.fn();
    const pr = { number: 4017, comments: listed };
    expect(enrichPrsWithCompleteComments([pr], { repo, readComments: () => comments, onError, annotate: p => p }))
      .toEqual([{ ...pr, comments, commentsComplete: true }]);
    expect(onError).not.toHaveBeenCalled();
  });

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

  it.each([
    ['id', { id: 'IC_clearance' }, { id: 'IC_clearance' }],
    ['node_id', { id: 'IC_clearance' }, { node_id: 'IC_clearance' }],
    ['url', { url: 'https://github.com/o/n/issues/4017#issuecomment-1' },
      { html_url: 'https://github.com/o/n/issues/4017#issuecomment-1' }],
  ])('drops a matching %s read whose stale body omits the embedded human clearance', (_name, listedIds, fullIds) => {
    const listed = { ...listedIds, author: { login: 'web-everything' },
      body: `${buildReviewedShaMarker('a'.repeat(40))}\n${buildClearedHumanMarker('chalbert')}` };
    const pr = { number: 4017, comments: [listed, ...firstPage.slice(1)] };
    const onError = vi.fn();
    const annotate = vi.fn(p => p);
    const complete = [...firstPage.slice(1), { ...fullIds, body: 'stale discussion' }, { body: 'later discussion' }];
    expect(enrichPrsWithCompleteComments([pr], { repo, readComments: () => complete, onError, annotate })).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(pr, expect.objectContaining({ message: 'complete comments read did not cover the listed page' }));
    expect(annotate).not.toHaveBeenCalled();
  });

  describe.each(['id', 'timestamp'])('author coverage with matching %s and body', identity => {
    const listed = { ...(identity === 'id' ? { id: 'IC_author' } : { createdAt: '2026-10-06T00:00:00Z' }), body: 'listed discussion' };
    const complete = { ...(identity === 'id' ? { node_id: 'IC_author' } : { created_at: listed.createdAt }), body: listed.body };

    it.each([
      ['author missing', { author: { login: 'web-everything' } }, {}],
      ['user missing', { user: { login: 'web-everything' } }, {}],
      ['author changed to another user', { author: { login: 'web-everything' } }, { user: { login: 'other' } }],
      ['user changed to another author', { user: { login: 'web-everything' } }, { author: { login: 'other' } }],
    ])('fails closed and skips annotation when the complete comment has its %s', (_name, listedAuthor, fullAuthor) => {
      const pr = { number: 4017, comments: [{ ...listed, ...listedAuthor }, ...firstPage.slice(1)] };
      const onError = vi.fn();
      const annotate = vi.fn(p => p);
      const out = enrichPrsWithCompleteComments([pr], {
        repo, readComments: () => [...firstPage.slice(1), { ...complete, ...fullAuthor }, { body: 'later discussion' }],
        onError, annotate,
      });
      expect(out.map(p => p.number)).toEqual([]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(pr,
        expect.objectContaining({ message: 'complete comments read did not cover the listed page' }));
      expect(annotate).not.toHaveBeenCalled();
    });

    it.each([
      ['normalized author / user', { author: { login: 'Web-Everything' } }, { user: { login: 'web-everything[bot]' } }],
      ['normalized user / author', { user: { login: 'Web-Everything[bot]' } }, { author: { login: 'web-everything' } }],
      ['author / author', { author: { login: 'web-everything' } }, { author: { login: 'web-everything' } }],
      ['author / user', { author: { login: 'web-everything' } }, { user: { login: 'web-everything' } }],
      ['user / author', { user: { login: 'web-everything' } }, { author: { login: 'web-everything' } }],
      ['user / user', { user: { login: 'web-everything' } }, { user: { login: 'web-everything' } }],
      ['neither has an author', {}, {}],
      ['only the complete comment has an author', {}, { user: { login: 'web-everything' } }],
    ])('accepts complete coverage with %s', (_name, listedAuthor, fullAuthor) => {
      const pr = { number: 4017, comments: [{ ...listed, ...listedAuthor }, ...firstPage.slice(1)] };
      const comments = [...firstPage.slice(1), { ...complete, ...fullAuthor }, { body: 'later discussion' }];
      const onError = vi.fn();
      expect(enrichPrsWithCompleteComments([pr], { repo, readComments: () => comments, onError, annotate: p => p }))
        .toEqual([{ ...pr, comments, commentsComplete: true }]);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  it('accepts an exactly page-sized covering read proved complete by the reader', () => {
    const pr = { number: 4017, comments: firstPage };
    const onError = vi.fn();
    const annotate = vi.fn(p => p);
    expect(enrichPrsWithCompleteComments([pr], { repo, readComments: () => [...firstPage], onError, annotate }))
      .toEqual([{ ...pr, commentsComplete: true }]);
    expect(onError).not.toHaveBeenCalled();
    expect(annotate).toHaveBeenCalledTimes(1);
    expect(annotate).toHaveBeenCalledWith({ ...pr, commentsComplete: true });
  });

  it.each([3, LIST_COMMENTS_PAGE_SIZE - 1])('short threads of %i comments are untouched and never re-read', count => {
    const prs = [{ number: 2, comments: filler(count) }];
    expect(enrichPrsWithCompleteComments(prs, { readComments: () => { throw new Error('no'); } })).toEqual(prs);
  });

  it.each([
    ['different ids despite matching body and timestamp', { id: 'IC_listed' }, { node_id: 'IC_other' }],
    ['different bodies without ids', {}, { body: 'other discussion' }],
    ['different timestamps without ids', {}, { created_at: '2026-10-07T00:00:00Z' }],
  ])('rejects an equal-length read omitting an embedded comment: %s', (_name, listedFields, fullFields) => {
    const listed = { body: 'listed discussion', createdAt: '2026-10-06T00:00:00Z', ...listedFields };
    const replacement = { body: listed.body, created_at: listed.createdAt, ...fullFields };
    const pr = { number: 4017, comments: [listed, ...firstPage.slice(1)] };
    const onError = vi.fn();
    const annotate = vi.fn(p => p);
    const out = enrichPrsWithCompleteComments([pr], {
      repo, readComments: () => [...firstPage.slice(1), replacement], onError, annotate,
    });
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(pr, expect.any(Error));
    expect(annotate).not.toHaveBeenCalled();
  });

  it.each([
    ['node_id matches id', { id: 'IC_listed' }, { node_id: 'IC_listed' }],
    ['id matches id', { id: 'IC_listed' }, { id: 'IC_listed' }],
    ['url matches html_url', { url: 'https://github.com/o/n/issues/4017#issuecomment-1' },
      { html_url: 'https://github.com/o/n/issues/4017#issuecomment-1' }],
    ['body and timestamp without ids', {}, {}],
    ['body and timestamp when only listed has an id', { id: 'IC_listed' }, {}],
    ['body and timestamp when only complete has an id', {}, { id: 'IC_listed' }],
  ])('marks a longer-than-page covering read with matching bodies complete: %s', (_name, listedFields, fullFields) => {
    const listed = { body: 'listed discussion', createdAt: '2026-10-06T00:00:00Z', ...listedFields };
    const pr = { number: 4017, comments: [listed, ...firstPage.slice(1)] };
    const complete = [...firstPage.slice(1), { body: listed.body, created_at: listed.createdAt, ...fullFields }, { body: 'later discussion' }];
    const onError = vi.fn();
    const readComments = vi.fn(() => complete);
    expect(enrichPrsWithCompleteComments([pr], { repo, readComments, onError, annotate: p => p }))
      .toEqual([{ ...pr, comments: complete, commentsComplete: true }]);
    expect(readComments).toHaveBeenCalledTimes(1);
    expect(readComments).toHaveBeenCalledWith(pr.number, { repo });
    expect(onError).not.toHaveBeenCalled();
  });

  it('reads through the safe reader with a large buffer and surfaces failures', () => {
    const seen = [];
    const exec = (f, a, o) => {
      seen.push(o.maxBuffer);
      return a[1] === 'graphql'
        ? JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } })
        : 'hi\t2026-01-01T00:00:00Z\tchalbert\tIC_1\n';
    };
    const c = readCompletePrComments(7, { repo, exec });
    expect(c[0].author.login).toBe('chalbert');
    expect(seen[0]).toBeGreaterThanOrEqual(1024 * 1024);
    expect(() => readCompletePrComments(7, { repo, exec: () => { throw new Error('ENOBUFS'); } })).toThrow();
  });
});


it('annotates short and complete threads through the injected reader', () => {
  const seen = [];
  const annotate = (pr) => { seen.push(pr.number); return { ...pr, annotated: true }; };
  const out = enrichPrsWithCompleteComments([{ number: 1, comments: [] }, { number: 2, comments: filler(100) }], { annotate, readComments: () => [...filler(100), { body: 'later discussion' }] });
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
