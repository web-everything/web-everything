import { describe, it, expect, vi } from 'vitest';
import { parsePrResultTable, classifyMergeGateHold, excuseMergeGateRows, resolveMergeGateHoldSetting, readMergeGateVerdict } from '../merge-gate-hold-class.mjs';
import { runReconcilePass } from '../../conveyor/reconcile-pass.mjs';
import { defaultReadHeadCheckState } from '../../operations/promote-draft-pr-dispatch.mjs';

const log4965 = `2026-10-12T09:49:30.3934630Z #4965: HOLD
2026-10-12T09:49:30.3936795Z   hold              candidate-label        no "ready-to-merge" label — the drain never considers it
2026-10-12T09:49:30.3938131Z   hold              producer-certified     not AI-generated, no ready-to-merge label, not human-cleared
2026-10-12T09:49:30.3939344Z   pass              default-base           base main vs main
2026-10-12T09:49:30.3946148Z   hold              review-hold-labels     unsatisfied review hold label without review:accepted
2026-10-12T09:49:30.3950221Z   hold              review-acceptance      park: human-gated (review:human) — only a human may clear it [...]
2026-10-12T09:49:30.3953575Z   hold              test-gaming            test-gaming suspected: tests-removed: ...
2026-10-12T09:49:30.3956372Z   pass              red-main-freeze        no freeze (ops/red-main-freeze:red-main-freeze.json + ci.yml@main)
2026-10-12T09:49:30.3959386Z   hold              ledger                 labels: labels hold
2026-10-12T09:49:30.3959878Z merge-gate: HOLD — held`;
const log5008 = `#5008: HOLD
  pass              candidate-label        ready-to-merge present
  hold              red-main-freeze        main is RED (freeze: manual freeze: merge-queue switch: ruleset apply (operator go 2026-10-12))
  pass              ledger                 labels: labels clear (ledger not consulted)
merge-gate: HOLD — held`;
const candidacy = log4965.split('\n').filter(l => !l.includes('test-gaming')).join('\n');
const sha = 'a'.repeat(40);
const row = { name: 'merge-gate', id: 123, status: 'COMPLETED', conclusion: 'FAILURE' };
const green = { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' };
const verdict = (log = candidacy) => ({ ...parsePrResultTable(log, log.includes('#5008') ? 5008 : 4965), head_sha: sha, completed_at: '2026-10-12T11:56:08Z' });
const classify = (results, extra = {}) => classifyMergeGateHold({ results, prLabels: ['review:pending'], ...extra });
const opts = (extra = {}) => ({ prNumber: 4965, headSha: sha, labels: ['review:pending'], setting: { value: 'on' }, readVerdict: () => verdict(), ...extra });

describe('strict job table parser', () => {
  it('parses the real #4965 excerpt', () => expect(parsePrResultTable(log4965, 4965)).toMatchObject({ num: 4965, ok: false, results: expect.arrayContaining([{ status: 'hold', id: 'ledger', reason: 'labels: labels hold' }]) }));
  it.each([log4965.replace('candidate-label', 'unknown-gate'), log4965.replace('hold              candidate', 'mystery           candidate'), log4965.replace('producer-certified', 'candidate-label'), log4965.replace('#4965: HOLD', '#4965: PASS')])('rejects malformed or contradictory evidence', log => expect(parsePrResultTable(log, 4965).error).toBeTruthy());
  it('last matching header wins, even if malformed', () => {
    expect(parsePrResultTable(`${log4965}\n#4965: PASS\n  pass ledger clear`, 4965)).toMatchObject({ ok: true, results: [{ status: 'pass', id: 'ledger', reason: 'clear' }] });
    expect(parsePrResultTable(`${candidacy}\n#4965: HOLD`, 4965).error).toBeTruthy();
  });
});
describe('hold classification', () => {
  it('excuses candidacy only', () => expect(classify(verdict().results)).toMatchObject({ excused: true, kind: 'candidacy' }));
  it('keeps test-gaming real', () => expect(classify(verdict(log4965).results)).toMatchObject({ excused: false, kind: 'real' }));
  it.each(['codeql', 'default-base', 'manifest-baseline', 'non-empty-body', 'duplicate-id-on-main', 'couple-whole', 'blocked-by'])('keeps %s real', id => expect(classify([{ id, status: 'hold', reason: 'blocked' }]).excused).toBe(false));
  it('never excuses fail-closed or a current candidate', () => {
    expect(classify([{ id: 'candidate-label', status: 'fail-closed' }]).excused).toBe(false);
    expect(classify(verdict().results, { prLabels: [{ name: 'ready-to-merge' }] }).excused).toBe(false);
  });
  it.each([['labels: labels hold', true], ['ledger unavailable', false]])('ledger authority %s', (reason, excused) => expect(classify([{ id: 'ledger', status: 'hold', reason }]).excused).toBe(excused));
  it.each([[{ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }, true], [{ frozen: true }, false], [{ error: 'unreadable' }, false], [{ frozen: false, publishedAt: '2026-10-12T10:00:00Z' }, false]])('stale shared freeze %j', (freeze, excused) => expect(classify(verdict(log5008).results, { freeze, verdictCompletedAt: '2026-10-12T11:56:08Z' })).toMatchObject({ excused, kind: excused ? 'stale-freeze' : 'real' }));
  it('main CI red is real; combined candidacy + stale freeze is identified', () => {
    const extra = { freeze: { frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }, verdictCompletedAt: '2026-10-12T11:56:08Z' };
    expect(classify([{ id: 'red-main-freeze', status: 'hold', reason: 'main is RED' }], extra).excused).toBe(false);
    expect(classify([...verdict().results.filter(r => r.id !== 'red-main-freeze'), ...verdict(log5008).results.filter(r => r.status === 'hold')], extra).kind).toBe('candidacy+stale-freeze');
  });
});
describe('settings and row evidence', () => {
  it('resolves all layers and fails closed on any invalid layer', () => {
    expect(resolveMergeGateHoldSetting({ platform: {}, repo: {}, env: {} })).toEqual({ value: 'on', source: 'standard' });
    expect(resolveMergeGateHoldSetting({ platform: {}, repo: {}, env: { MERGE_GATE_CANDIDACY_HOLD_IS_NOT_CI_FAILURE: 'off' } })).toEqual({ value: 'off', source: 'env' });
    expect(resolveMergeGateHoldSetting({ platform: { mergeGate: { candidacyHoldIsNotCiFailure: 'bad' } }, repo: {}, env: {} })).toMatchObject({ value: 'off', why: expect.stringContaining('invalid') });
    expect(resolveMergeGateHoldSetting({ platform: { mergeGate: { candidacyHoldIsNotCiFailure: 'off' } }, repo: { mergeGate: { candidacyHoldIsNotCiFailure: 'on' } }, env: {} }).source).toBe('repo');
  });
  it.each([{ setting: { value: 'off' } }, { readVerdict: () => ({ error: 'no log' }) }, { headSha: 'b'.repeat(40) }, { prNumber: 5000 }, { readVerdict: () => { throw Error('read failed'); } }])('preserves red on missing authority %j', extra => expect(excuseMergeGateRows([row], opts(extra)).rows).toEqual([row]));
  it('replaces only latest merge-gate and retains other red checks', () => {
    const badTest = { ...green, conclusion: 'FAILURE' };
    const out = excuseMergeGateRows([{ ...row, id: 122 }, row, badTest], opts());
    expect(out.rows).toEqual([{ ...row, conclusion: 'SUCCESS', mergeGateHoldExcused: { kind: 'candidacy', holds: expect.any(Array), jobId: 123 } }, badTest]);
    expect(excuseMergeGateRows([{ ...row, status: 'completed', conclusion: 'failure' }], opts()).rows[0].conclusion).toBe('success');
  });
  it('never reads a superseded failure', () => {
    const readVerdict = vi.fn();
    excuseMergeGateRows([row, { ...row, id: 124, conclusion: 'SUCCESS' }], opts({ readVerdict }));
    expect(readVerdict).not.toHaveBeenCalled();
  });
  it('reads and caches immutable job evidence with throttled gh', () => {
    const runGh = vi.fn(args => args[1].endsWith('/logs') ? candidacy : JSON.stringify({ head_sha: sha, completed_at: '2026-10-12T11:56:08Z' }));
    const cache = new Map();
    const options = { repo: 'owner/repo', jobId: 123, prNumber: 4965, runGh, cache };
    expect(readMergeGateVerdict(options)).toMatchObject({ num: 4965, head_sha: sha });
    readMergeGateVerdict(options);
    expect(runGh).toHaveBeenCalledTimes(2);
    expect(runGh.mock.calls[0][1].throttle.op).toBe('merge-gate-verdict');
  });
});
const identity = x => x;
function plan({ setting = 'on', draft = false, testRed = false, readVerdict = () => verdict(), ...extra } = {}) {
  return runReconcilePass({ readPrs: () => [{ number: 4965, headRefOid: sha, headRefName: 'lane/4965-example', baseRefName: 'main', labels: [{ name: 'review:pending' }], comments: [], isDraft: draft, statusCheckRollup: [row, { ...green, conclusion: testRed ? 'FAILURE' : 'SUCCESS' }] }],
    readAgents: () => [], enrich: identity, readRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readChecks: () => [row, green],
    readMergeGateVerdict: readVerdict, readFreeze: () => ({ error: 'not needed' }), mergeGateSetting: { value: setting },
    enrichMainRed: prs => ({ prs, mainRedWindows: [] }),
    ...Object.fromEntries(['enrichAlreadyLanded', 'enrichBaseRef', 'enrichSystemFix', 'enrichEscalationBase', 'enrichFixClaims', 'enrichTimeouts', 'enrichReferralHolds', 'enrichLedgerHolds', 'enrichRulings', 'enrichScopeBloat', 'enrichCodeQL', 'enrichMechanicalRound'].map(k => [k, identity])),
    resolveMainSha: () => null, readPriority: () => null, ...extra });
}
describe('reconcile planner and fresh promotion', () => {
  it('off reproduces ci-heal; on owes review', () => {
    expect(plan({ setting: 'off' }).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
    const after = plan();
    expect(after.dispatch.some(d => d.kind === 'ci-heal')).toBe(false);
    expect(after.dispatch.some(d => d.kind === 'review')).toBe(true);
  });
  it('promotes a candidacy-held draft', () => expect(plan({ draft: true }).dispatch.some(d => d.kind === 'promote-draft')).toBe(true));
  it.each([{ testRed: true }, { readVerdict: () => ({ error: 'missing' }) }])('keeps real CI failure red (#5020) or unreadable verdict', args => expect(plan(args).dispatch.some(d => d.kind === 'ci-heal')).toBe(true));
  it('does not read freeze for candidacy', () => { const readFreeze = vi.fn(); plan({ readFreeze }); expect(readFreeze).not.toHaveBeenCalled(); });
  it.each([[candidacy, 'green'], [log4965, 'red']])('fresh head read classifies verdict as %s', (log, state) => {
    const readPrLabels = vi.fn(() => ['review:pending']);
    const result = defaultReadHeadCheckState({ repoSlug: 'owner/repo', prNumber: 4965, sha, runGh: () => [row, green].map(r => JSON.stringify(r)).join('\n'), getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readPrLabels, readMergeGateVerdict: () => verdict(log), mergeGateSetting: { value: 'on' } });
    expect(result.state).toBe(state);
    expect(readPrLabels).toHaveBeenCalled();
  });
});

it('reads a shared freeze at most once across a pass', () => {
  const readFreeze = vi.fn(() => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }));
  const readPrs = () => [5008, 5009].map(number => ({ number, headRefOid: sha, headRefName: `lane/${number}-example`, baseRefName: 'main', labels: [{ name: 'review:pending' }], comments: [], isDraft: true, statusCheckRollup: [row, green] }));
  const result = plan({ readPrs, readFreeze, readVerdict: ({ prNumber }) => ({ ...verdict(log5008), num: prNumber }) });
  expect(readFreeze).toHaveBeenCalledTimes(1);
  expect(result.dispatch.filter(d => d.kind === 'promote-draft')).toHaveLength(2);
});
it('keeps all PR rows unchanged when the injected excusal step throws', () => {
  expect(plan({ excuseMergeGateHolds: () => { throw Error('unavailable'); } }).dispatch.some(d => d.kind === 'ci-heal')).toBe(true);
});
it('uses a rollup detailsUrl job id and case-insensitive head binding', () => {
  const readVerdict = vi.fn(() => ({ ...verdict(), head_sha: sha.toUpperCase() }));
  const input = { name: 'merge-gate', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/100/job/123' };
  expect(excuseMergeGateRows([input], opts({ readVerdict })).rows[0].conclusion).toBe('SUCCESS');
  expect(readVerdict).toHaveBeenCalledWith(expect.objectContaining({ jobId: 123, prNumber: 4965 }));
});
it('missing labels, job id or completion never authorize excusal', () => {
  expect(excuseMergeGateRows([row], opts({ labels: undefined })).rows).toEqual([row]);
  const noId = { ...row, id: undefined };
  expect(excuseMergeGateRows([noId], opts()).rows).toEqual([noId]);
  const pending = { ...row, status: 'IN_PROGRESS' };
  expect(excuseMergeGateRows([pending], opts()).rows).toEqual([pending]);
});
