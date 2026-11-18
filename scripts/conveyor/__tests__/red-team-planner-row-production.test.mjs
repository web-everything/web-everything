import { expect, it, vi } from 'vitest';
import { readPlannerRow } from '../../lib/red-team-planner-row.mjs';
import { runReconcilePass } from '../reconcile-pass.mjs';
import { buildCiHealEscalationComment } from '../ci-heal-escalation-mark.mjs';

vi.mock('node:child_process', async original => ({ ...await original(), execFileSync: vi.fn(() => '[]') }));
vi.mock('../../lib/gh-throttle.mjs', async original => ({ ...await original(),
  execFileSyncThrottled: vi.fn(() => '[]'), runGhSync: vi.fn(() => '[]') }));
const identity = value => value;
const head = 'a'.repeat(40), pr = 5762;
const check = (name, conclusion = 'failure', extra = {}) => ({ name, status: 'completed', conclusion, ...extra });
const options = source => ({ repo: 'we', now: 2_000_000, env: {},
  readPrs: () => [source], readAgents: () => [], enrich: identity,
  readRequiredChecks: () => ({ checks: ['test', 'review-gate', 'merge-gate'] }), resolveMainSha: () => null,
  excuseMergeGateHolds: prs => prs.map(row => ({ ...row, statusCheckRollup: row.statusCheckRollup.map(c =>
    c.name === 'merge-gate' ? { ...c, mergeGateReviewHold: { holds: ['review-gate'], jobId: 5874001 } } : c) })),
  enrichMainRed: prs => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: identity,
  enrichBaseRef: identity, enrichSystemFix: identity, enrichEscalationBase: identity,
  enrichFixClaims: identity, enrichTimeouts: identity, enrichReferralHolds: identity,
  enrichReferralAutoResolve: identity, enrichLedgerHolds: identity,
  enrichRulings: identity, enrichScopeBloat: identity, enrichCodeQL: identity,
  enrichOwedMainRule: identity, enrichStandingRulingGrants: identity, enrichMechanicalRound: identity,
  loadMechanicalRoundsSetting: () => ({ value: true, source: 'fixture' }), stepLog: () => {},
});
const source = () => ({ number: pr, headRefOid: head, headRefName: 'lane/5762-example', state: 'OPEN',
  labels: [{ name: 'review:pending' }], comments: [], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [check('test', 'success'), check('review-gate'), check('merge-gate')] });

it.each([false, true])('recomputes daemon and external classifications from their current snapshots (readOnly=%s)', readOnly => {
  const raw = source();
  const plan = runReconcilePass({ ...options(raw), readOnly });
  expect(plan.plannerRequiredChecks).toEqual(['test', 'review-gate', 'merge-gate']);
  const row = readPlannerRow({ repo: 'web-everything/web-everything', pr, plan, rawPrs: [raw] });
  expect(row.absent).toBe(false);
  expect(row.refusal).toBe(plan.refusals.find(r => r.prNumber === pr));
  expect(plan.plannerRows[0].reviewOwnedChecks).toMatchObject({ reviewOwned: ['review-gate', 'merge-gate'],
    nonReviewOwned: [], gatesOnlyRed: true, onlyRed: true });
  expect(row.reviewOwnedChecks).toMatchObject({ reviewOwned: ['review-gate'],
    nonReviewOwned: ['merge-gate'], gatesOnlyRed: false, onlyRed: false });
  expect(raw.statusCheckRollup[2]).not.toHaveProperty('mergeGateReviewHold');
  expect(row.reviewOwnedChecks).not.toBe(plan.plannerRows[0].reviewOwnedChecks);
});

it('exposes scope-bloat folded by the normal not-a-ci-break escalation, without nominating a new path', () => {
  const scopeBloat = { stale: true, why: 'stale base carries unrelated changes' };
  const raw = { ...source(), scopeBloat, statusCheckRollup: [check('test')],
    comments: [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({
      headSha: head, outcome: 'not-a-ci-break', reason: 'review hold' }) }] };
  const plan = runReconcilePass({ ...options(raw), readOnly: true, readRequiredChecks: () => ({ checks: ['test'] }) });
  const row = readPlannerRow({ pr, plan });
  expect(row.refusal).toMatchObject({ kind: 'ci-heal-escalated', reviewRefusal: { kind: 'scope-bloat', scopeBloat } });
  expect(row.refusal.reviewRefusal).not.toHaveProperty('ciHealNotCiBreak');
  expect(plan.dispatch).toEqual([]);
});

it.each([false, true])('produces independent safety evidence behind early CI refusals (readOnly=%s)', readOnly => {
  const raw = { ...source(), isDraft: false, labels: ['review:human'],
    files: [{ path: 'scripts/guard.mjs', additions: 1, deletions: 0 }] };
  const scopeBloat = { stale: true, why: 'unrelated files' };
  const plan = runReconcilePass({ ...options(raw), readOnly,
    loadPrOwnership: () => ({ advisoryReviewOnHumanHandoff: { value: 'off', source: 'fixture' } }),
    readRequiredChecks: () => ({ checks: ['test', 'review-gate'] }),
    enrichScopeBloat: prs => prs.map(pr => ({ ...pr, scopeBloat })) });
  const row = readPlannerRow({ pr, plan, rawPrs: [raw] });
  expect(row.refusal.kind).toBe('review-ci');
  expect(row.refusal.reviewRefusal).toBeUndefined();
  expect(raw).not.toHaveProperty('scopeBloat');
  expect(plan.plannerRows[0].nominationSafety).toMatchObject({ head, hold: expect.stringContaining('scope-bloat') });
  expect(row.nominationSafety).not.toBe(plan.plannerRows[0].nominationSafety);
  expect(row.nominationSafety.hold ?? '').not.toContain('scope-bloat');
});
