import { describe, it, expect } from 'vitest';
import { decideReviewGate, REVIEW_LABELS } from '../review-escalation.mjs';

const H = REVIEW_LABELS.human;
const base = { escalate: true, humanRequired: false, humanScoreFresh: true, labels: [H] };

describe('sticky review:human de-escalation on a fresh net-diff score', () => {
  it('drops a sticky review:human to review:pending when the fresh net score is humanRequired=false', () => {
    const g = decideReviewGate(base);
    expect(g.action).toBe('park');
    expect(g.applyLabel).toBe(REVIEW_LABELS.pending);
    expect(g.humanRequired).toBe(false);
    expect(g.deescalatedHuman).toBe(true);
    expect(g.removeLabels).toEqual([H]);
  });

  it('keeps review:human when the fresh net score is still humanRequired=true', () => {
    const g = decideReviewGate({ ...base, humanRequired: true });
    expect(g.applyLabel).toBe(H);
    expect(g.humanRequired).toBe(true);
    expect(g.deescalatedHuman).toBeUndefined();
  });

  it('keeps review:human when the score is not proven fresh (fail closed, also the legacy default)', () => {
    for (const humanScoreFresh of [false, undefined]) {
      const g = decideReviewGate({ ...base, humanScoreFresh });
      expect(g.applyLabel).toBe(H);
      expect(g.humanRequired).toBe(true);
    }
  });

  it('keeps review:human when humanRequired is missing even if freshness is asserted', () => {
    const g = decideReviewGate({ escalate: true, humanScoreFresh: true, labels: [H] });
    expect(g.applyLabel).toBe(H);
    expect(g.deescalatedHuman).toBeUndefined();
  });

  it('keeps review:human when an operator ruling pinned it', () => {
    const g = decideReviewGate({ ...base, humanPinned: true });
    expect(g.applyLabel).toBe(H);
    expect(g.humanRequired).toBe(true);
  });

  it('never de-escalates a PR that also carries review:accepted', () => {
    const g = decideReviewGate({ ...base, labels: [H, REVIEW_LABELS.accepted] });
    expect(g.deescalatedHuman).toBeUndefined();
  });

  it('de-escalates a review:changes + review:human PR as wait-author with humanRequired=false', () => {
    const g = decideReviewGate({ ...base, labels: [H, REVIEW_LABELS.changes] });
    expect(g.action).toBe('wait-author');
    expect(g.humanRequired).toBe(false);
    expect(g.deescalatedHuman).toBe(true);
  });

  it('a PR without the human label is unaffected', () => {
    const g = decideReviewGate({ ...base, labels: [REVIEW_LABELS.pending] });
    expect(g.applyLabel).toBe(REVIEW_LABELS.pending);
    expect(g.deescalatedHuman).toBeUndefined();
  });
});
