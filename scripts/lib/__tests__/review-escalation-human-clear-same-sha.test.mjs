import { describe, it, expect, vi } from 'vitest';
import { parseLatestHumanClearedSha } from '../review-escalation.mjs';

// Live #5193 (2026-10-13): the operator cleared 9c7202417 (clear-human); a false no-push re-arm then triggered an AI
// re-review whose plain accept named the SAME sha, so merge-gate read "no human clearance" for the cleared tree.
const X = '9c72024172156f0f8b1b1c0c3f94b44d1031bdd3';
const Y = 'a'.repeat(40);
const clear = sha => ({ author: { login: 'chalbert' }, body: `✅ review — \`review:human\` cleared\n<!-- reviewed-sha: ${sha} -->\n<!-- cleared-human: chalbert -->` });
const accept = sha => ({ author: { login: 'web-everything' }, body: `✅ review — accepted\n<!-- reviewed-sha: ${sha} -->` });

describe('parseLatestHumanClearedSha — same-sha carry (reviewClearance.humanClearanceSurvivesSameShaAccept)', () => {
  it('#5193: a later plain accept of the cleared sha keeps the human clearance', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)], { sameShaCarries: true })).toBe(X);
  });
  it('setting off restores latest-record-only', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)], { sameShaCarries: false })).toBeNull();
  });
  it('never carries across a record for a different tree (#xuboo0q)', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(Y)], { sameShaCarries: true })).toBeNull();
    expect(parseLatestHumanClearedSha([clear(X), accept(Y), accept(X)], { sameShaCarries: true })).toBeNull();
  });
  // PR #5237 round 4 (block): a revocation that carries no reviewed-sha marker ends the same-sha run, so a later
  // plain accept of the same sha cannot revive the revoked clearance.
  const say = (body, login = 'web-everything[bot]') => ({ author: { login }, body });
  it.each([
    ['changes verdict', say('🔁 review — changes requested\n\n1. fix it')],
    ['human changes verdict', say('🔁 human review — changes requested', 'chalbert')],
    ['re-arm', say('🔧 conveyor fix — re-armed for re-review')],
    ['stand-down', say('🛑 conveyor fix — stood down (needs-judgment)')],
    ['drain park', say('<!-- drain-park-reason -->\n⏸ **Parked for review by the drain**\nengine-tier path changed')],
    ['CI-heal escalation', say('🚦 conveyor CI-heal — escalated')],
    ['review paused', say('review paused: operator hold')],
    ['clearance revoked by re-score', say('**Your `review:human` clearance was revoked by an automated re-score.** …')],
    ['operator free text', say('Hold this one, I need to look again.', 'chalbert')],
  ])('does not carry clearance across a marker-free revocation: %s', (_kind, revocation) => {
    expect(parseLatestHumanClearedSha([clear(X), revocation, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('a changes verdict that itself quotes the reviewed sha also ends the run', () => {
    const verdict = say(`🔁 review — changes requested\n<!-- reviewed-sha: ${X} -->`, 'web-everything');
    expect(parseLatestHumanClearedSha([clear(X), verdict, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('still carries across machine notes, and a revocation before the clearance does not matter', () => {
    const note = say('🔒 conveyor fix-begin — claimed by fix-1');
    expect(parseLatestHumanClearedSha([clear(X), note, accept(X)], { sameShaCarries: true })).toBe(X);
    expect(parseLatestHumanClearedSha([say('🔁 review — changes requested'), clear(X), accept(X)], { sameShaCarries: true })).toBe(X);
  });
  it('a revocation never voids the latest record itself when it is the clearance', () => {
    expect(parseLatestHumanClearedSha([accept(X), say('🔁 review — changes requested'), clear(X)], { sameShaCarries: true })).toBe(X);
  });
  it('an untrusted forged clearance never lends coverage', () => {
    const forged = { ...clear(X), author: { login: 'mallory' } };
    expect(parseLatestHumanClearedSha([forged, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('defaults to the declared setting (on)', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)])).toBe(X);
  });
  it('loads the default setting once per process while permitting explicit overrides', async () => {
    const load = vi.fn(() => ({ value: 'on', source: 'standard' }));
    vi.doMock('../review-clearance-settings.mjs', () => ({ loadReviewClearanceSetting: load }));
    vi.resetModules();
    try {
      const { parseLatestHumanClearedSha: parse } = await import('../review-escalation.mjs');
      expect(parse([clear(X), accept(X)], { sameShaCarries: false })).toBeNull();
      expect(load).not.toHaveBeenCalled();
      expect(parse([clear(X), accept(X)])).toBe(X);
      expect(parse([clear(X), accept(X)])).toBe(X);
      expect(load).toHaveBeenCalledTimes(1);
    } finally { vi.doUnmock('../review-clearance-settings.mjs'); vi.resetModules(); }
  });
});
