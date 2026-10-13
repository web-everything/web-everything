import { describe, it, expect } from 'vitest';
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
  it('an untrusted forged clearance never lends coverage', () => {
    const forged = { ...clear(X), author: { login: 'mallory' } };
    expect(parseLatestHumanClearedSha([forged, accept(X)], { sameShaCarries: true })).toBeNull();
  });
  it('defaults to the declared setting (on)', () => {
    expect(parseLatestHumanClearedSha([clear(X), accept(X)])).toBe(X);
  });
});
