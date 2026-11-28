import { describe, it, expect, vi } from 'vitest';

const path = '../fix-review-floor.mjs';
const mod = await import(path).catch(() => ({}));
const mark = '<!-- dispatch requires-review: true -->';
const trusted = body => ({ author: { login: 'chalbert' }, body });
const count = totalCount => JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount } } } } });
const input = { repo: 'web-everything/web-everything', pr: 42 };

describe('threadRequiresReview floors only on a trusted whole-line mark', () => {
  it.each([
    ['trusted author', [trusted(mark)], true],
    ['surrounding spaces and tabs', [trusted(`preface\r\n \t${mark}\t \r\nend`)], true],
    ['null', null, true], ['non-array', {}, true],
    ['sticky after three later comments', [trusted(mark), ...[1, 2, 3].map(n => trusted(String(n)))], true],
    ['reversed order', [...[1, 2, 3].map(n => trusted(String(n))), trusted(mark)], true],
    ['untrusted author', [{ author: { login: 'outsider' }, body: mark }], false],
    ['missing author', [{ body: mark }], false],
    ['mid-line', [trusted(`prefix ${mark}`)], false], ['empty thread', [], false],
  ])('%s', (_name, comments, expected) => {
    expect(typeof mod.threadRequiresReview).toBe('function');
    expect(mod.threadRequiresReview(comments)).toBe(expected);
  });

  it.each([
    ['throwing reader', () => { throw Error('timed out'); }], ['missing reader', undefined],
    ['non-array reader', () => ({})],
  ])('floors a %s', (_name, reader) => {
    expect(typeof mod.reviewCareFloor).toBe('function');
    expect(mod.reviewCareFloor(reader, input)).toBe(true);
  });

  it.each([false, true])('proves a paginated 150-comment thread (incomplete=%s)', incomplete => {
    expect(typeof mod.completeThreadReader).toBe('function');
    expect(typeof mod.reviewCareFloor).toBe('function');
    const rows = Array.from({ length: 150 }, (_, i) =>
      `${!incomplete && i === 140 ? mark : 'discussion'}\t2026-01-01T00:00:00Z\tchalbert\tIC_${i}\n`).join('');
    const exec = vi.fn().mockReturnValueOnce(rows).mockReturnValueOnce(count(incomplete ? 151 : 150));
    expect(mod.reviewCareFloor(mod.completeThreadReader(exec), input)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][1]).toContain('--paginate');
    expect(exec.mock.calls[1][1]).toEqual(expect.arrayContaining(['owner=web-everything', 'name=web-everything', 'n=42']));
  });

  it('renders the mark on its own line and posts inert argv through a bounded transport', () => {
    expect(typeof mod.renderRequiresReviewMark).toBe('function');
    expect(typeof mod.postRequiresReviewMark).toBe('function');
    const kind = 'fix $(untrusted)';
    const body = mod.renderRequiresReviewMark({ kind, rung: null });
    expect(body.split('\n')).toContain(mark);
    expect(body).toContain('`default`');
    const exec = vi.fn(() => '');
    mod.postRequiresReviewMark({ repo: 'we', pr: 42, kind, exec });
    expect(exec).toHaveBeenCalledWith('gh', ['pr', 'comment', '42', '--repo', input.repo, '--body', body],
      expect.objectContaining({ timeout: 30_000, encoding: 'utf8' }));
  });

  it('propagates a failed mark transport instead of reporting a posted mark', () => {
    expect(typeof mod.postRequiresReviewMark).toBe('function');
    expect(() => mod.postRequiresReviewMark({ ...input, kind: 'fix', exec: () => { throw Error('denied'); } })).toThrow('denied');
  });
});
