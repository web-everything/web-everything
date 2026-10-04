import { describe, it, expect } from 'vitest';
import { mintSessionSlug, parseSessionSlug, PR_KINDS, ITEM_KINDS } from '../session-slug.mjs';
import { repoSlugTag, repoKeyForSlugTag, repoKeyForSlug } from '../../lib/constellation-repos.mjs';

describe('session slugs', () => {
  for (const repo of ['we', 'frontierui', 'plateau-app']) {
    for (const kind of PR_KINDS) it(`round trips ${repo} ${kind}`, () => {
      const tag = repoSlugTag(repo);
      const slug = mintSessionSlug({ kind, id: 49, repo });
      expect(slug).toBe(`${kind}-${tag ? `${tag}-` : ''}49`);
      expect(parseSessionSlug(slug)).toEqual({ kind, repo, id: '49', attempt: '', itemKind: false });
      expect(parseSessionSlug(`${slug}A`.toUpperCase())).toEqual({ kind, repo, id: '49', attempt: 'a', itemKind: false });
      expect(repoKeyForSlugTag(tag)).toBe(repo);
    });
  }
  for (const kind of ITEM_KINDS) it(`preserves WE ${kind} names and hashes`, () => {
    for (const attempt of ['', 'b']) {
      expect(mintSessionSlug({ kind, id: '3441', attempt })).toBe(`${kind}-3441${attempt}`);
      expect(parseSessionSlug(mintSessionSlug({ kind, id: '3441', attempt }))).toEqual({ kind, repo: 'we', id: '3441', attempt, itemKind: true });
      expect(mintSessionSlug({ kind, id: 'x9ylkp7', attempt })).toBe(`${kind}-x9ylkp7${attempt}`);
    }
    for (const repo of ['frontierui', 'plateau-app']) expect(() => mintSessionSlug({ kind, id: 3, repo })).toThrow(/require repo we/);
  });
  it('fails closed on invalid inputs', () => {
    for (const name of ['conveyor-x9ylkp7', 'conveyor-fui-3', 'prepare-pa-9', 'review-other-3', 'review-fui-x9ylkp7', 'review-3ab']) expect(parseSessionSlug(name)).toBeNull();
    for (const id of ['', 0, -1, 1.2, 'x9ylkp7']) expect(() => mintSessionSlug({ kind: 'review', id })).toThrow();
    expect(() => mintSessionSlug({ kind: 'review', id: 1, repo: 'other' })).toThrow(/unknown repo/);
    expect(() => mintSessionSlug({ kind: 'other', id: 1 })).toThrow(/unknown kind/);
    expect(() => mintSessionSlug({ kind: 'fix', id: 1, attempt: 'b' })).toThrow(/no attempt/);
    expect(repoKeyForSlugTag()).toBe('we');
    expect(repoKeyForSlugTag('other')).toBeNull();
    expect(repoSlugTag('other')).toBeNull();
    expect(repoKeyForSlug('frontier-ui/frontierui')).toBe('frontierui');
    expect(repoKeyForSlug('plateau-app')).toBe('plateau-app');
  });
});
