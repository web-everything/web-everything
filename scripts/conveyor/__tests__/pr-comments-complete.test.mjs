import { describe, it, expect } from 'vitest';
import { enrichPrsWithCompleteComments, readCompletePrComments, LIST_COMMENTS_PAGE_SIZE } from '../pr-comments-complete.mjs';
import { countGrantedRoundExtensions, buildRoundExtensionComment } from '../round-extension-mark.mjs';
import { planNoteComment } from '../reconcile-note-comment.mjs';

const repo = 'web-everything/web-everything';
const filler = (n) => Array.from({ length: n }, (_, i) => ({ author: { login: 'web-everything' }, body: `drain park-reason spam ${i} ${'x'.repeat(10_000)}` }));
const grant = (by) => ({ author: { login: 'chalbert' }, body: buildRoundExtensionComment({ repo, pr: 4017, by, actor: 'chalbert', channel: 'test', reason: 'more', at: '2026-10-06T10:44:55Z' }) });
const note = { kind: 'round-cap-exhausted', prNumber: 4017, attempts: 6, cap: 5, text: 'PR #4017: review auto-repair rounds exhausted (6/5)' };

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
