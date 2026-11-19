import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { pinnedDiffMergeRefusal } from '../merge-ai-prs.mjs';

const HEAD = 'a'.repeat(40);

describe('merge path refuses an unpinned or unscored net diff regardless of REVIEW_ESCALATION', () => {
  it('refuses when there is no clone to read from', () => {
    expect(pinnedDiffMergeRefusal({ exec: null, headSha: HEAD, baseRev: 'main' })).toMatch(/unscored/);
  });
  it('refuses when the pinned base cannot be fetched', () => {
    const exec = () => { throw new Error('fetch failed'); };
    expect(pinnedDiffMergeRefusal({ exec, headSha: HEAD, baseRev: 'main' })).toMatch(/unscored/);
  });
  it('refuses a malformed head sha', () => {
    expect(pinnedDiffMergeRefusal({ exec: () => '', headSha: 'nope', baseRev: 'main' })).toMatch(/unscored/);
  });
  it('is applied in the !REVIEW_ESCALATION backstop before the label check', () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const start = src.indexOf('if (!REVIEW_ESCALATION) {');
    const end = src.indexOf('if (REVIEW_ESCALATION) {', start);
    const block = src.slice(start, end);
    expect(block).toContain('pinnedDiffMergeRefusal(');
    expect(block.indexOf('pinnedDiffMergeRefusal(')).toBeLessThan(block.indexOf('hasUnclearedReviewLabel('));
  });
});
