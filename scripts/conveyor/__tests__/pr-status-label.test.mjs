// One `status:*` label per PR — what it is waiting on (operator ask 2026-10-10: #4708/#4689/#4631 sat at the
// round cap and their labels did not show it).
import { describe, it, expect } from 'vitest';
import { derivePrStatusLabel, planPrStatusLabel, PR_STATUS_LABEL_RE } from '../pr-status-label.mjs';
import { tagReviewStatus } from '../review-status-tag.mjs';
import { takeoverMarkerBody } from '../fix-takeover.mjs';

const BOT = { login: 'web-everything' };
const HEAD = 'a'.repeat(40);
const at = (h) => `2026-10-10T${String(h).padStart(2, '0')}:00:00Z`;
const marker = (h) => ({ author: BOT, createdAt: at(h), body: takeoverMarkerBody({ pr: 7, head: HEAD, attempts: 5, cap: 5, rung: { id: 'x' } }) });
const advisory = (h) => ({ author: BOT, createdAt: at(h), body: `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** x\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\`` });
const pr = (labels = [], comments = [], over = {}) => ({ number: 7, headRefOid: HEAD, baseRefName: 'main', labels: labels.map((name) => ({ name })), comments, ...over });
const derive = (o) => derivePrStatusLabel({ humanAt: 99, ...o });

describe('derivePrStatusLabel', () => {
  it('at the round cap: a planned takeover, a takeover head awaiting its one review, or a capped PR read at-round-limit', () => {
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'fix', mode: 'takeover' }] })).toBe('at-round-limit');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review', takeoverReview: { ok: true } }] })).toBe('at-round-limit');
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'takeover-awaiting-review' }] })).toBe('at-round-limit');
  });
  it('a live fixer on an unjudged takeover is takeover-running; once judged, plain fixing', () => {
    expect(derive({ pr: pr(['review:changes'], [marker(7)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('takeover-running');
    expect(derive({ pr: pr(['review:changes'], [marker(7), advisory(8)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('fixing');
  });
  it('a spent budget, a non-converging takeover or a ruling dispute is the operator\'s: needs-you', () => {
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'cap-exhausted', takeover: 'takeover-budget-spent' }] })).toBe('needs-you');
    expect(derive({ pr: pr(['review:changes']), rows: [{ kind: 'cap-exhausted', takeover: 'takeover-not-converging' }] })).toBe('needs-you');
    expect(derive({ pr: pr([]), rows: [{ kind: 'ruling-dispute' }] })).toBe('needs-you');
  });
  it('the waiting states, and accepted = ready-to-merge', () => {
    expect(derive({ pr: pr(['review:pending']), reviewStatus: { role: 'draft', state: 'awaiting-base' } })).toBe('awaiting-base');
    expect(derive({ pr: pr([]), rows: [{ kind: 'gate-hold', hold: 'stacked-base-unmerged' }] })).toBe('awaiting-base');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review-ci' }] })).toBe('awaiting-ci');
    expect(derive({ pr: pr(['review:pending']), rows: [{ kind: 'review' }] })).toBe('awaiting-review');
    expect(derive({ pr: pr(['review:accepted']) })).toBe('ready-to-merge');
    expect(derive({ pr: pr([]) })).toBeNull();
  });
});

describe('planPrStatusLabel: exactly one status label', () => {
  it('adds the desired one and removes every other status:* label', () => {
    expect(planPrStatusLabel({ state: 'fixing', currentLabels: ['status:awaiting-review', 'status:needs-you', 'review:changes'] }))
      .toEqual({ add: 'status:fixing', remove: ['status:awaiting-review', 'status:needs-you'] });
    expect(planPrStatusLabel({ state: 'fixing', currentLabels: ['status:fixing'] })).toEqual({ add: null, remove: [] });
    expect(planPrStatusLabel({ state: null, currentLabels: ['status:fixing'] })).toEqual({ add: null, remove: ['status:fixing'] });
    expect(PR_STATUS_LABEL_RE.test('status:bogus')).toBe(false);
  });
});

describe('tagReviewStatus writes the status label in the same pass (one writer)', () => {
  it('the same writer applies the review-status and the status:* label', () => {
    const calls = [];
    const provider = { readLabels: () => [], ensureLabel: () => {}, setLabels: (repo, n, change) => calls.push(change), readPrState: () => null };
    const r = tagReviewStatus({ pr: 7, repo: 'web-everything/web-everything', provider, agents: [], currentLabels: [{ name: 'review:changes' }],
      prState: pr(['review:changes']), readFixClaim: () => ({ meta: {} }), planRows: [] });
    expect(calls.map((c) => c.add)).toEqual(['review-status:fixing', 'status:fixing']);
    expect(r.prStatus).toBe('status:fixing');
  });
});

describe('a paused review does not judge the takeover (live #4708)', () => {
  const paused = (h) => ({ author: BOT, createdAt: at(h), body: `**⚠️ THIS IS AN ADVISORY REVIEW, NOT A RECORDED VERDICT.** Pending: 2 mandatory referral(s) await a ruling\n\nNet basis: \`${'0'.repeat(40)}..${HEAD}\`` });
  it('a live fixer after a takeover whose review only paused is still a running takeover', () => {
    expect(derive({ pr: pr([], [marker(1), paused(2)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('takeover-running');
    expect(derive({ pr: pr([], [marker(1), advisory(2)]), reviewStatus: { role: 'fix', state: 'fixing' } })).toBe('fixing');
  });
  it('the last takeover head\'s owed review is at-round-limit, not needs-you', () => {
    expect(derive({ pr: pr([], [marker(1), paused(2)]), rows: [{ kind: 'review', takeoverReview: { ok: true } }] })).toBe('at-round-limit');
  });
});
