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
    // Opaque (binary) content needs the PR's complete trusted thread to find a head-bound human clearance.
    expect(block).toMatch(/pinnedDiffMergeRefusal\(\{[^}]*readComments: \(\) => readCompletePrComments\(/);
  });
  it('the escalation path routes opaque content through the head-bound tamper clearance and never carries it', () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const start = src.indexOf('const gaming = ');
    const block = src.slice(start, src.indexOf('shouldReparkForTestTampering({', start) + 200);
    expect(block.startsWith('const gaming = withOpaqueDiffHold(scanTestTampering(')).toBe(true);
    expect(block).toMatch(/humanClearedSha !== tamperHeadSha && !gaming\.opaqueFiles/);
  });
  it('pr-land forces review:human for opaque content in the producer escalation', () => {
    const src = readFileSync('scripts/pr-land.mjs', 'utf8');
    const start = src.indexOf('const applyReviewEscalationLabel = () => {');
    const block = src.slice(start, src.indexOf('const finalLabel = ', start));
    expect(block).toContain('opaqueDiffEscalation(sig.netDiffText.text)');
    expect(block).toMatch(/const humanRequired = [^\n]*opaque\.humanRequired/);
  });
});
