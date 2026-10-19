// @vitest-environment node
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { auditCardUnionCarry, PENDING_RESTAMP_REFUSAL } from '../card-union-carry.mjs';
import { decideSetLabel } from '../../review-set-label.mjs';

beforeEach(() => vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on'));
afterEach(() => vi.unstubAllEnvs());

it('preserves the pending restamp refusal', () => {
  expect(decideSetLabel({ to: 'restamp', currentLabels: ['review:pending'] })).toMatchObject({ allowed: false, reason: PENDING_RESTAMP_REFUSAL });
});
it('prints dry-run decisions and totals without creating acceptance', () => {
  const write = vi.fn(); const prove = vi.fn(() => ({ ok: true, reason: 'union only' }));
  const provider = { readPrFiles: () => ['backlog/1-card.md'], readPrReviews: () => [], readComments: () => [
    { author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${'a'.repeat(40)} -->`, createdAt: '2026-10-18T00:00:00Z' },
    { author: { login: 'chalbert' }, body: '🔧 conveyor fix — re-armed for re-review', createdAt: '2026-10-19T00:00:00Z' },
  ] };
  auditCardUnionCarry({ repo: 'o/r', prs: [{ number: 1, labels: ['review:pending'], mergeable: 'MERGEABLE', headRefOid: 'b'.repeat(40) }], provider, prove, write, setting: { value: true, source: 'standard' } });
  expect(prove).toHaveBeenCalledOnce();
  expect(write.mock.calls[0][0]).toBe(`PR #1 REREVIEW ${PENDING_RESTAMP_REFUSAL}; proof passes; dry-run`);
  expect(write.mock.calls[1][0]).toBe('TOTAL candidates=1 pending=1 RESTAMP=0 REREVIEW=1');
});

it('prints every pending PR while counting only card-only candidates', () => {
  const write = vi.fn();
  const provider = {
    readPrFiles: vi.fn((_repo, number) => number === 1 ? ['src/app.js'] : ['backlog/1-card.md']),
    readPrReviews: vi.fn(),
    readComments: vi.fn(),
  };
  const prove = vi.fn();
  const result = auditCardUnionCarry({
    repo: 'o/r',
    prs: [
      { number: 1, labels: ['review:pending'], mergeable: 'MERGEABLE' },
      { number: 2, labels: [{ name: 'review:pending' }], mergeable: 'CONFLICTING' },
      { number: 3, labels: ['review:pending'], mergeable: 'UNKNOWN' },
      { number: 4, labels: ['review:accepted'], mergeable: 'MERGEABLE' },
    ],
    provider, prove, write,
  });
  expect(write.mock.calls.map(([line]) => line)).toEqual([
    'PR #1 REREVIEW not card-only (relaxation #10 covers card-only PRs)',
    'PR #2 REREVIEW not currently mergeable (CONFLICTING)',
    'PR #3 REREVIEW not currently mergeable (UNKNOWN)',
    'TOTAL candidates=2 pending=3 RESTAMP=0 REREVIEW=2',
  ]);
  expect(result).toEqual({ candidates: 2, restamp: 0, rereview: 2 });
  expect(provider.readPrFiles).toHaveBeenCalledTimes(3);
  expect(provider.readComments).not.toHaveBeenCalled();
  expect(provider.readPrReviews).not.toHaveBeenCalled();
  expect(prove).not.toHaveBeenCalled();
});

it('refuses the catch-up proof when global acceptance carry is off', () => {
  vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'off');
  const write = vi.fn(); const prove = vi.fn();
  const provider = { readPrFiles: () => ['backlog/1-card.md'], readPrReviews: () => [], readComments: () => [
    { author: { login: 'chalbert' }, body: `<!-- reviewed-sha: ${'a'.repeat(40)} -->`, createdAt: '2026-10-18T00:00:00Z' },
    { author: { login: 'chalbert' }, body: '🔧 conveyor fix — re-armed for re-review', createdAt: '2026-10-19T00:00:00Z' },
  ] };
  auditCardUnionCarry({ repo: 'o/r', prs: [{ number: 1, labels: ['review:pending'], mergeable: 'MERGEABLE', headRefOid: 'b'.repeat(40) }],
    provider, prove, write, setting: { value: true } });
  expect(prove).not.toHaveBeenCalled();
  expect(write.mock.calls[0][0]).toMatch(/carryAcceptanceOnUnion.*acceptCarryForward=off/);
});
