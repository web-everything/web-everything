// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runReviewLabelCli, buildVerdictComment } from '../review-set-label.mjs';
import { appendVerdict } from '../lib/verdict-ledger.mjs';
import { proveCardUnionOnly } from '../lib/card-union-carry.mjs';

// Keep the real CLI and acceptance readers; isolate git proof and the durable ledger sink.
vi.mock('../lib/card-union-carry.mjs', async importOriginal => ({
  ...await importOriginal(),
  resolveCardUnionCarrySetting: () => ({ value: true }),
  proveCardUnionOnly: vi.fn(() => ({ ok: true })),
}));
vi.mock('../lib/verdict-ledger.mjs', async importOriginal => ({
  ...await importOriginal(),
  appendVerdict: vi.fn(),
}));

beforeEach(() => vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on'));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllEnvs(); });

const acceptedHead = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const comment = body => ({ author: { login: 'web-everything' }, createdAt: '2026-10-19T12:00:00Z', body });

describe('card-union restamp rechecks acceptance immediately before the swap', () => {
  function run(revoke = () => {}) {
    const live = {
      state: 'OPEN', headRefOid: newHead, labels: ['review:accepted'], body: '',
      comments: [comment(`<!-- reviewed-sha: ${acceptedHead} -->`)], reviews: [],
    };
    const provider = {
      name: 'stub', currentRepo: () => 'o/n',
      // No branch ref: the unrelated diff-fingerprint read remains unscored without git IO.
      readPrState: vi.fn(() => ({ ...live, labels: [...live.labels], comments: [...live.comments] })),
      readLabels: () => live.labels,
      readComments: vi.fn(() => live.comments),
      readPrReviews: vi.fn(() => live.reviews),
      setLabels: vi.fn(), postComment: vi.fn(),
    };
    // This seam is after the successful preflight and before applySwap. No real ledger write.
    appendVerdict.mockImplementation(() => { revoke(live); return { ok: true }; });
    const chunks = [];
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    let exitCode = 0;
    try {
      runReviewLabelCli({
        argv: ['7', '--repo=o/n', '--to=restamp', '--actor=conflict-watch', '--channel=card-union',
          `--new-head=${newHead}`, `--card-union-accepted=${acceptedHead}`],
        defaultActor: 'test', usage: 'test', provider, buildComment: buildVerdictComment,
        referralOptions: { readRuns: () => [] },
        successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }),
        signalFix: vi.fn(), emit: s => chunks.push(s),
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    return { provider, live, exitCode, payload: JSON.parse(chunks.join('') || '{}') };
  }

  it.each([
    ['later verdict', live => {
      live.labels.push('review:human');
      live.comments.push(comment('🔁 review — changes requested'));
    }, /gate-self/],
    ['comment-only revocation', live => { live.comments.push(comment('🔁 review — changes requested')); }, /superseded/],
    ['different accepted SHA', live => { live.comments.push(comment(`<!-- reviewed-sha: ${'c'.repeat(40)} -->`)); }, /superseded/],
    ['body-derived hold', live => { live.comments.push(comment('manifest baseline mismatch')); }, /superseded/],
    ['unreadable reviews', live => { live.reviews = null; }, /reviews unreadable/],
    ['formal review revocation', live => {
      live.reviews = [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-19T13:00:00Z' }];
    }, /superseded/],
    ['acceptance label removed', live => { live.labels = ['review:changes']; }, /no review:accepted/],
    ['head moved', live => { live.headRefOid = 'c'.repeat(40); }, /head or PR state changed/],
  ])('refuses %s arriving after preflight with no PR writes', (_name, revoke, reason) => {
    const r = run(revoke);
    expect(proveCardUnionOnly).toHaveBeenCalledWith({ acceptedHead, newHead });
    expect(appendVerdict).toHaveBeenCalledTimes(1); // Proves the earlier fresh-state check passed.
    expect(r.exitCode).toBe(1);
    expect(r.payload.error).toMatch(reason);
    expect(r.provider.setLabels).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled();
    if (_name === 'later verdict') expect(r.live.labels).toContain('review:human');
  });

  it('refuses before proof or writes when global acceptance carry is off', () => {
    vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'off');
    const r = run();
    expect(r.exitCode).toBe(1);
    expect(r.payload.error).toMatch(/carryAcceptanceOnUnion.*acceptCarryForward=off/);
    expect(proveCardUnionOnly).not.toHaveBeenCalled();
    expect(appendVerdict).not.toHaveBeenCalled();
    expect(r.provider.setLabels).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled();
  });

  it('still restamps when acceptance remains standing', () => {
    const r = run();
    expect(r.exitCode).toBe(0);
    expect(r.provider.setLabels).toHaveBeenCalledTimes(1);
    expect(r.provider.postComment).toHaveBeenCalledTimes(1);
    expect(r.provider.readComments).toHaveBeenCalledTimes(2); // Preflight and immediately before swap.
  });
});
