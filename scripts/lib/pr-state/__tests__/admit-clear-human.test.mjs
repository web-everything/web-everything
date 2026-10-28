// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { admitClearHuman } from '../admit-clear-human.mjs';
import { labelsDigest, commentVersion } from '../snapshot.mjs';

const HEAD = 'a'.repeat(40);
const NOW = Date.parse('2026-10-28T12:00:00Z');
const BUDGET = 5_000;
const SNAPSHOT_FIELDS = ['head', 'labels', 'labelsVersion', 'comments', 'reviews',
  'openReferrals', 'redTeam', 'standingRulings', 'holdEventIds', 'humanOnlyHold', 'netDiff', 'now'];
const CONFIG_FIELDS = ['ineligibleLabels', 'commitBudgetMs', 'decideSetLabel', 'scoreDiff'];

function fixture() {
  const snapshot = {
    head: HEAD, labels: ['review:human', 'area:docs'],
    labelsVersion: '2026-10-28T11:59:00Z',
    comments: [
      { id: 'C2', author: 'reviewer', body: 'Evidence two',
        createdAt: '2026-10-28T11:00:00Z', lastEditedAt: null },
      { id: 'C1', author: 'operator', body: 'Evidence one',
        createdAt: '2026-10-28T10:00:00Z', lastEditedAt: null },
    ],
    reviews: [], openReferrals: [], redTeam: { resultId: null, rulingNeeded: false },
    standingRulings: [], holdEventIds: ['hold:2', 'hold:1'], humanOnlyHold: false,
    netDiff: { headSha: HEAD, files: ['docs/example.md'], diffLines: 12 }, now: NOW,
  };
  const calls = { decide: [], score: [] };
  const config = {
    ineligibleLabels: ['do-not-merge', 'security-review'], commitBudgetMs: BUDGET,
    decideSetLabel: input => { calls.decide.push(input); return { allowed: true }; },
    scoreDiff: input => { calls.score.push(input); return { escalate: false }; },
  };
  const options = { delegation: { pinnedHead: HEAD, expiresAt: NOW + 60_000 }, config };
  return { snapshot, options, calls };
}

describe('admitClearHuman', () => {
  it('admits the baseline, copies the hold basis, and fences labels/comments/head', () => {
    const { snapshot, options, calls } = fixture();
    const result = admitClearHuman(snapshot, options);
    expect(result).toEqual({
      admit: true, reasons: [], basis: ['hold:2', 'hold:1'],
      fence: { headSha: HEAD, labelsDigest: labelsDigest(snapshot.labels),
        commentVersion: commentVersion(snapshot.comments) },
    });
    expect(result.basis).not.toBe(snapshot.holdEventIds);
    expect(calls.decide).toEqual([{ to: 'clear-human', currentLabels: [...snapshot.labels].sort(),
      humanOnlyHold: false, redTeamRulingHold: false }]);
    expect(calls.score).toEqual([snapshot.netDiff]);
  });

  const cases = [
    ['head-moved', f => { f.snapshot.head = 'b'.repeat(40); }],
    ['ineligible-label:do-not-merge', f => { f.snapshot.labels.push('do-not-merge'); }],
    ['ineligible-label:security-review', f => { f.snapshot.labels.push('security-review'); }],
    ['open-referral:finding:1', f => { f.snapshot.openReferrals = ['finding:1']; }],
    ['red-team-ruling-needed', f => { f.snapshot.redTeam = { resultId: 'RT1', rulingNeeded: true }; }],
    ['decide-refused', f => { f.options.config.decideSetLabel = () => ({ allowed: false }); }],
    ['diff-escalates', f => { f.options.config.scoreDiff = () => ({ escalate: true }); }],
    ['delegation-expired', f => { f.options.delegation.expiresAt = NOW + BUDGET; }],
  ];

  it.each(cases)('returns exactly the isolated reason %s', (reason, change) => {
    const f = fixture();
    change(f);
    const result = admitClearHuman(f.snapshot, f.options);
    expect(result.reasons).toEqual([reason]);
    expect(result.admit).toBe(false);
  });

  it('reports each ineligible label and each open referral', () => {
    const f = fixture();
    f.snapshot.labels.push('do-not-merge', 'security-review');
    f.snapshot.openReferrals = ['finding:1', 'finding:2'];
    const result = admitClearHuman(f.snapshot, f.options);
    expect(result.admit).toBe(false);
    expect([...result.reasons].sort()).toEqual([
      'ineligible-label:do-not-merge', 'ineligible-label:security-review',
      'open-referral:finding:1', 'open-referral:finding:2',
    ].sort());
  });

  it('passes the human-only hold to the policy without inventing a reason', () => {
    const f = fixture();
    f.snapshot.humanOnlyHold = true;
    const result = admitClearHuman(f.snapshot, f.options);
    expect(result.reasons).toEqual([]);
    expect(result.admit).toBe(true);
    expect(f.calls.decide).toEqual([{ to: 'clear-human', currentLabels: [...f.snapshot.labels].sort(),
      humanOnlyHold: true, redTeamRulingHold: false }]);
  });

  it('passes the red-team ruling hold to the label policy', () => {
    const f = fixture();
    f.snapshot.redTeam = { resultId: 'RT1', rulingNeeded: true };
    admitClearHuman(f.snapshot, f.options);
    expect(f.calls.decide).toEqual([{ to: 'clear-human', currentLabels: [...f.snapshot.labels].sort(),
      humanOnlyHold: false, redTeamRulingHold: true }]);
  });

  it.each([NOW - 1, NOW, NOW + BUDGET - 1, NOW + BUDGET])(
    'refuses delegation expiring at %i with the commit budget included', expiresAt => {
      const f = fixture();
      f.options.delegation.expiresAt = expiresAt;
      expect(admitClearHuman(f.snapshot, f.options).reasons).toEqual(['delegation-expired']);
    });

  it('admits one millisecond beyond the commit budget and reads expiry once', () => {
    const f = fixture();
    let reads = 0;
    Object.defineProperty(f.options.delegation, 'expiresAt', {
      get() { reads += 1; return NOW + BUDGET + 1; },
    });
    expect(admitClearHuman(f.snapshot, f.options).admit).toBe(true);
    expect(reads).toBe(1);
  });

  it('is deterministic for repeated calls and shuffled comments and labels', () => {
    const f = fixture();
    const first = admitClearHuman(f.snapshot, f.options);
    expect(admitClearHuman(f.snapshot, f.options)).toEqual(first);
    const shuffled = structuredClone(f.snapshot);
    shuffled.comments.reverse();
    shuffled.labels.reverse();
    const result = admitClearHuman(shuffled, f.options);
    expect(result).toEqual(first);
    expect(result.fence).toEqual(first.fence);
  });

  it('hands the label policy a canonical label order, so an order-sensitive policy cannot change admission', () => {
    const f = fixture();
    f.options.config.decideSetLabel = ({ currentLabels }) => ({ allowed: currentLabels[0] === 'area:docs' });
    const reversed = structuredClone(f.snapshot);
    reversed.labels.reverse();
    expect(admitClearHuman(reversed, f.options)).toEqual(admitClearHuman(f.snapshot, f.options));
  });

  it('does not mutate any part of the input snapshot', () => {
    const f = fixture();
    const before = structuredClone(f.snapshot);
    admitClearHuman(f.snapshot, f.options);
    expect(f.snapshot).toEqual(before);
  });

  it.each(['delegation', 'config'])('throws without %s', key => {
    const f = fixture();
    delete f.options[key];
    expect(() => admitClearHuman(f.snapshot, f.options)).toThrow();
  });

  it.each(CONFIG_FIELDS)('throws without config.%s', key => {
    const f = fixture();
    delete f.options.config[key];
    expect(() => admitClearHuman(f.snapshot, f.options)).toThrow();
  });

  it.each(SNAPSHOT_FIELDS)('fails closed without snapshot.%s', key => {
    const f = fixture();
    delete f.snapshot[key];
    expect(() => admitClearHuman(f.snapshot, f.options)).toThrow();
  });
});
