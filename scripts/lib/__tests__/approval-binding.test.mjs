// approval-binding (operator 2026-10-21): an operator clear-human clearance is bound to the PR's net-change
// fingerprint, not the commit sha. Real-git replays of the day's cases plus the never-weaken refusals.
import { describe, it, expect } from 'vitest';
import {
  clearanceCovers, clearanceBindsHead,
  resolveClearanceBindingSettings, logClearanceBindingSettings, _resetClearanceBindingLog,
} from '../approval-binding.mjs';
import {
  decideReviewGate, decideContradictoryVerdictHeal, shouldReparkForTestTampering, REVIEW_LABELS,
} from '../review-escalation.mjs';

const settings = { bindTo: { value: 'fingerprint', source: 'test' }, normalizeNumbering: { value: true, source: 'test' } };

describe('clearanceCovers — never weakened', () => {
  it('the existing kill switches narrow it: carry off → sha only; numbering carry off → no numbering normalization', () => {
    const off = { value: false, source: 'env' };
    const on = { value: true, source: 'test' };
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: off, numberingCarry: on }).bindTo.value).toBe('sha');
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: on, numberingCarry: off }).normalizeNumbering.value).toBe(false);
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null, humanCarry: on, numberingCarry: on }))
      .toMatchObject({ bindTo: { value: 'fingerprint' }, normalizeNumbering: { value: true } });
  });

  it('unreadable evidence fails closed', () => {
    const clearance = { sha: 'a'.repeat(40), diff: 'b'.repeat(64), contribution: 'c'.repeat(64) };
    const liveHead = 'd'.repeat(40);
    const reviews = [];
    expect(clearanceCovers({ clearance, liveHead, reviews }).covers).toBe(false);
    // Even a strict (byte-identical text) match needs the replay proof.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) })).toMatchObject({ covers: true, tier: 'fingerprint' });
    // A proven numbering run whose base fails the replay is not covered.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: (sha) => (sha === liveHead ? { diff: 'f'.repeat(64), contribution: 'f'.repeat(64) }
      : { diff: 'b'.repeat(64), contribution: 'c'.repeat(64) }), numberingProof: () => ({ ok: true, base: 'e'.repeat(40), reason: 'numbering' }),
      proveReplay: () => ({ ok: false, reason: 'differs' }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => null }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => { throw new Error('git'); } }).covers).toBe(false);
    // Contribution match without the replay proof is not enough.
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: false, reason: 'conflict' }) }).covers).toBe(false);
    expect(clearanceCovers({ clearance, liveHead, reviews, fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) })).toMatchObject({ covers: true, tier: 'contribution' });
    // strict equivalence policy refuses the contribution tier outright.
    expect(clearanceCovers({ clearance, liveHead, reviews, equivalence: 'strict', fingerprintOf: () => ({ diff: 'e'.repeat(64), contribution: 'c'.repeat(64) }),
      proveReplay: () => ({ ok: true, reason: 'replayed' }) }).covers).toBe(false);
  });
});

describe('clearanceBindsHead — the readers\' one predicate', () => {
  const head = 'a'.repeat(40);
  it('honours a sha match, or a covering verdict computed for THIS head only', () => {
    expect(clearanceBindsHead({ humanClearedSha: head, headSha: head })).toBe(true);
    expect(clearanceBindsHead({ humanClearedSha: 'b'.repeat(40), headSha: head })).toBe(false);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: true, liveHead: head } })).toBe(true);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: true, liveHead: 'c'.repeat(40) } })).toBe(false);
    expect(clearanceBindsHead({ headSha: head, coverage: { covers: 'yes', liveHead: head } })).toBe(false);
    expect(clearanceBindsHead({ headSha: null, coverage: { covers: true, liveHead: head } })).toBe(false);
  });

  it('routes the tamper re-park and both heals', () => {
    const cov = { covers: true, liveHead: head };
    expect(shouldReparkForTestTampering({ tampered: true, netDiffScored: true, humanClearedSha: 'b'.repeat(40), headSha: head })).toBe(true);
    expect(shouldReparkForTestTampering({ tampered: true, netDiffScored: true, humanClearedSha: 'b'.repeat(40), headSha: head, clearanceCoverage: cov })).toBe(false);
    const pendingAccepted = [REVIEW_LABELS.pending, REVIEW_LABELS.accepted];
    expect(decideContradictoryVerdictHeal({ currentLabels: pendingAccepted, acceptedSha: 'b'.repeat(40), headSha: head, fetchOk: true }).heal).toBe(true);
    expect(decideContradictoryVerdictHeal({ currentLabels: pendingAccepted, acceptedSha: 'b'.repeat(40), headSha: head, fetchOk: true, clearanceCoverage: cov }))
      .toMatchObject({ heal: false, reason: 'clearance-covers-head' });
    const humanAccepted = [REVIEW_LABELS.human, REVIEW_LABELS.accepted];
    expect(decideContradictoryVerdictHeal({ currentLabels: humanAccepted, humanClearedSha: 'b'.repeat(40), headSha: head, fetchOk: true }).heal).toBe(true);
    expect(decideContradictoryVerdictHeal({ currentLabels: humanAccepted, humanClearedSha: 'b'.repeat(40), headSha: head, fetchOk: true, clearanceCoverage: cov }))
      .toMatchObject({ heal: false, reason: 'genuine-clearance' });
  });

  it('a stale-looking accept is not re-parked when the clearance covers the head; review:changes still applies', () => {
    const cov = { covers: true, liveHead: head };
    const inputs = { labels: [REVIEW_LABELS.accepted], acceptedSha: 'b'.repeat(40), headSha: head, humanRequired: true };
    expect(decideReviewGate(inputs)).toMatchObject({ action: 'park', staleAcceptance: true });
    expect(decideReviewGate({ ...inputs, clearanceCoverage: cov }).action).toBe('merge');
    expect(decideReviewGate({ ...inputs, labels: [REVIEW_LABELS.changes], clearanceCoverage: cov }).action).toBe('wait-author');
  });
});

describe('review.clearance settings', () => {
  it('cascade: standard → tool → env, invalid values never override, source logged once', () => {
    expect(resolveClearanceBindingSettings({ env: {}, tool: {}, platform: null })).toMatchObject({ bindTo: { value: 'fingerprint' }, normalizeNumbering: { value: true } });
    expect(resolveClearanceBindingSettings({ env: {}, tool: { clearance: { bindTo: 'sha' } }, platform: null }).bindTo).toEqual({ value: 'sha', source: 'tool' });
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_BIND_TO: 'sha' }, tool: {}, platform: null }).bindTo).toEqual({ value: 'sha', source: 'env' });
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_BIND_TO: 'loose' }, tool: {}, platform: null }).bindTo.value).toBe('fingerprint');
    expect(resolveClearanceBindingSettings({ env: { WE_REVIEW_CLEARANCE_NORMALIZE_NUMBERING: 'off' }, tool: {}, platform: null }).normalizeNumbering).toEqual({ value: false, source: 'env' });
    _resetClearanceBindingLog();
    const lines = [];
    logClearanceBindingSettings(settings, (l) => lines.push(l));
    logClearanceBindingSettings(settings, (l) => lines.push(l));
    expect(lines).toEqual(['policy · review.clearance.bindTo=fingerprint (test) · review.clearance.normalizeNumbering=true (test)\n']);
  });
});
