// @vitest-environment node
import { isCandidacyHold, deferCandidacyHoldsOnPrEvent, loadMergeGateHoldSetting } from '../merge-gate-hold-class.mjs';
import { formatPrResult } from '../merge-gate-ci.mjs';
import { runDraftPromotionStep } from '../../conveyor/draft-promotion-loop.mjs';
import { readReviewCiGate, readReviewHeadAndLabels } from '../review-ci-gate-io.mjs';
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

describe('fast draft promotion merge-gate holds', () => {
  const repo = 'web-everything/web-everything';
  function step(extra = {}) {
    const pr = { number: 4965, state: 'OPEN', isDraft: true, headRefName: 'lane/4965-example',
      headRefOid: sha, baseRefName: 'main', labels: [], isCrossRepository: false,
      comments: [], body: '', statusCheckRollup: [row, green] };
    const readVerdict = extra.readMergeGateVerdict ?? vi.fn(() => verdict());
    const ready = vi.fn();
    const readHeadCheckState = vi.fn(args => defaultReadHeadCheckState({ ...args,
      runGh: () => [row, green].map(r => JSON.stringify(r)).join('\n'),
      getRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), readPrLabels: () => [],
      readMergeGateVerdict: readVerdict, mergeGateSetting: { value: 'on' } }));
    const result = runDraftPromotionStep({ repos: [repo], listDrafts: () => [pr],
      readHeadCheckState, readPrView: () => pr, readAgents: () => [], readClaim: () => null,
      readRequiredChecks: () => ({ checks: ['test', 'merge-gate'] }), ready, clearAwaiting: vi.fn(),
      readMergeGateVerdict: readVerdict, readFreeze: () => ({ error: 'unused' }), mergeGateSetting: 'on', ...extra });
    return { result, ready, readHeadCheckState, readVerdict, pr };
  }
  it('promotes candidacy-only holds through both fresh readers', () => {
    const out = step();
    expect(out.result.rows[0]).toMatchObject({ action: 'promoted' });
    expect(out.ready).toHaveBeenCalledWith(repo, 4965);
    expect(out.readHeadCheckState).toHaveBeenCalledWith({ repoSlug: repo, sha, prNumber: 4965 });
    expect(out.readVerdict).toHaveBeenCalledTimes(2);
    expect(out.readVerdict).toHaveBeenLastCalledWith({ repo, jobId: 123, prNumber: 4965 });
    expect(out.pr.statusCheckRollup[0].conclusion).toBe('FAILURE');
  });
  it.each(['real', 'unreadable', 'throws', 'off'])('keeps the planner rollup red for %s evidence', kind => {
    const out = step({ readHeadCheckState: () => ({ state: 'green' }),
      mergeGateSetting: kind === 'off' ? 'off' : 'on',
      readMergeGateVerdict: () => {
        if (kind === 'throws') throw Error('offline');
        return kind === 'unreadable' ? { error: 'missing' } : verdict(kind === 'real' ? candidacy.replace('candidate-label', 'codeql') : candidacy);
      } });
    expect(out.result.rows[0].action).toBe('skip');
    expect(out.ready).not.toHaveBeenCalled();
  });
  it('keeps a real hold red at the first head read', () => {
    const out = step({ readMergeGateVerdict: () => verdict(candidacy.replace('candidate-label', 'codeql')) });
    expect(out.result.rows[0]).toMatchObject({ action: 'skip', why: expect.stringContaining('read red') });
    expect(out.ready).not.toHaveBeenCalled();
  });
});

describe('fresh review CI merge-gate holds', () => {
  const repo = 'owner/repo';
  const rest = { ...row, status: 'completed', conclusion: 'failure', head_sha: sha,
    details_url: 'https://github.com/owner/repo/actions/runs/100/job/123' };
  function gate(extra = {}) {
    return readReviewCiGate({ repo, pr: 4965, readHead: () => sha, readLabels: () => [],
      readChecks: () => [rest, { context: 'legacy', state: 'success' }],
      readRequired: () => ({ source: 'live', checks: ['merge-gate', 'legacy'] }),
      readMergeGateVerdict: () => verdict(), readFreeze: () => ({ error: 'unused' }), mergeGateSetting: 'on', ...extra });
  }
  it('allows candidacy-only REST failures and preserves legacy statuses', () => {
    const readVerdict = vi.fn(() => verdict());
    expect(gate({ readMergeGateVerdict: readVerdict }).allowed).toBe(true);
    expect(readVerdict).toHaveBeenCalledWith({ repo, jobId: 123, prNumber: 4965 });
    expect(rest.conclusion).toBe('failure');
    expect(gate({ readChecks: () => [rest, { context: 'legacy', state: 'failure' }] })).toMatchObject({
      allowed: false, affected: [{ name: 'legacy', reason: 'failure' }],
    });
  });
  it('reads head and labels together and uses the final current labels', () => {
    const run = vi.fn()
      .mockReturnValueOnce(JSON.stringify({ headRefOid: sha, labels: [] }))
      .mockReturnValueOnce(JSON.stringify({ headRefOid: sha, labels: [{ name: 'ready-to-merge' }] }));
    expect(gate({ readHead: undefined, readLabels: undefined,
      readHeadAndLabels: args => readReviewHeadAndLabels({ ...args, run }) }).allowed).toBe(false);
    expect(run.mock.calls).toEqual(Array(2).fill([['pr', 'view', '4965', '--repo', repo, '--json', 'headRefOid,labels']]));
    expect(gate({ readHead: undefined, readLabels: undefined,
      readHeadAndLabels: () => ({ headRefOid: sha, labels: [] }) }).allowed).toBe(true);
  });
  it.each([undefined, () => undefined, () => { throw Error('labels unavailable'); }])('preserves red without readable labels', readLabels => {
    expect(gate({ readLabels })).toMatchObject({ allowed: false,
      affected: [{ name: 'merge-gate', reason: 'failure' }] });
  });
  it('excuses cleared freeze evidence and refuses an unreadable freeze', () => {
    const readMergeGateVerdict = () => ({ ...verdict(log5008), num: 4965 });
    expect(gate({ readMergeGateVerdict,
      readFreeze: () => ({ frozen: false, publishedAt: '2026-10-12T12:49:46.432Z' }) }).allowed).toBe(true);
    expect(gate({ readMergeGateVerdict, readFreeze: () => { throw Error('offline'); } })).toMatchObject({
      allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }],
    });
  });
  it('does not excuse a legacy merge-gate status', () => {
    const readMergeGateVerdict = vi.fn(() => verdict());
    expect(gate({ readChecks: () => [{ context: 'merge-gate', state: 'failure' },
      { context: 'legacy', state: 'success' }], readMergeGateVerdict })).toMatchObject({
      allowed: false, affected: [{ name: 'merge-gate', reason: 'failure' }],
    });
    expect(readMergeGateVerdict).not.toHaveBeenCalled();
  });
  it.each(['real', 'unreadable', 'throws', 'candidate', 'off'])('refuses %s evidence', kind => {
    const result = gate({ mergeGateSetting: kind === 'off' ? 'off' : 'on',
      readLabels: () => kind === 'candidate' ? [{ name: 'ready-to-merge' }] : [],
      readMergeGateVerdict: () => {
        if (kind === 'throws') throw Error('offline');
        return kind === 'unreadable' ? { error: 'missing' } : verdict(kind === 'real' ? candidacy.replace('candidate-label', 'codeql') : candidacy);
      } });
    expect(result).toMatchObject({ allowed: false, reason: 'required-checks-not-successful',
      affected: [{ name: 'merge-gate', reason: 'failure' }] });
  });
});

describe('facts-first review CI merge-gate refusals', () => {
  const repo = 'owner/repo';
  const pr = 4965;
  const readRequired = () => ({ source: 'live', checks: ['merge-gate', 'test'] });
  async function gate(failedCheck, live) {
    const { readReviewCiGateFactsFirst } = await import('../review-facts.mjs');
    return readReviewCiGateFactsFirst({ repo, pr, live, liveHead: () => sha,
      readRequired, mergeGateSetting: 'on',
      lookup: () => ({ facts: { state: 'open', headSha: sha, labels: ['review:pending'],
        checks: ['merge-gate', 'test'].map(name => ({ name, conclusion: name === failedCheck ? 'failure' : 'success' })),
      } }),
    });
  }
  it('re-reads a failed store merge-gate live so a candidacy hold can be allowed', async () => {
    const allowed = { allowed: true, headSha: sha, reason: 'required-checks-successful' };
    const live = vi.fn(() => allowed);
    expect(await gate('merge-gate', live)).toEqual(allowed);
    expect(live).toHaveBeenCalledTimes(1);
    expect(live).toHaveBeenCalledWith({ repo, pr, readRequired, mergeGateSetting: 'on' });
  });
  it('still trusts a completed test failure without reading the live gate', async () => {
    const live = vi.fn(() => ({ allowed: true }));
    expect(await gate('test', live)).toMatchObject({ allowed: false,
      reason: 'required-checks-not-successful', factsSource: 'store',
      affected: [{ name: 'test', reason: 'failure' }],
    });
    expect(live).not.toHaveBeenCalled();
  });
});

describe('PR-event candidacy deferral', () => {
  const key = 'prEventCandidacyHoldsPass';
  const envKey = 'MERGE_GATE_PR_EVENT_CANDIDACY_HOLDS_PASS';
  const held = (id, reason = 'pending', status = 'hold') => ({ id, reason, status });
  const pending = () => {
    const results = ['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance'].map(id => held(id));
    results.push(held('ledger', 'labels: labels hold'), held('codeql', 'clear', 'pass'));
    return { num: 5011, ok: false, results, blocking: results.filter(r => r.status === 'hold'), clearanceCarry: { retained: true } };
  };
  it.each(['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'ledger'])('recognizes only candidacy holds for %s', id => {
    expect(isCandidacyHold(held(id, 'labels: labels hold'))).toBe(true);
    for (const status of ['pass', 'fail-closed', 'skipped-by-policy']) expect(isCandidacyHold(held(id, 'labels: labels hold', status))).toBe(false);
  });
  it('rejects other ledger authority and other gates', () => {
    expect(isCandidacyHold(held('ledger', 'ledger: pending'))).toBe(false);
    expect(isCandidacyHold(held('test-gaming'))).toBe(false);
    expect(isCandidacyHold(null)).toBe(false);
  });
  it('defers candidacy, preserves metadata and inputs, and produces a parseable PASS', () => {
    const input = pending(), before = structuredClone(input);
    const out = deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting: { value: 'on' } });
    expect(out).toMatchObject({ num: 5011, ok: true, blocking: [], clearanceCarry: input.clearanceCarry });
    expect(out.results.slice(0, 5)).toEqual(input.blocking.map(r => ({ ...r, status: 'skipped-by-policy', reason: `candidacy hold deferred to the merge_group run (mergeGate.prEventCandidacyHoldsPass=on): ${r.reason}` })));
    expect(input).toEqual(before);
    expect(parsePrResultTable(formatPrResult(out), 5011)).toMatchObject({ ok: true, results: out.results });
  });
  it.each(['merge_group', 'workflow_dispatch', undefined, null, 'PULL_REQUEST', 'pull_request_target'])('leaves event %s unchanged', mergeEvent => {
    const input = pending();
    expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent, setting: 'on' })).toEqual(input);
  });
  it.each(['off', 'invalid', undefined])('leaves setting %s unchanged', setting => {
    const input = pending();
    expect(deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting })).toEqual(input);
  });
  it.each([
    ...['test-gaming', 'manifest-baseline', 'red-main-freeze', 'codeql', 'default-base', 'non-empty-body', 'duplicate-id-on-main', 'couple-whole', 'blocked-by'].map(id => held(id)),
    held('candidate-label', 'unreadable', 'fail-closed'), held('review-acceptance', 'human-only: workflow edit'), held('ledger', 'ledger: blocked'),
  ])('keeps $id / $reason blocking', row => {
    const input = pending(); input.results.push(row); input.blocking.push(row);
    const out = deferCandidacyHoldsOnPrEvent(input, { mergeEvent: 'pull_request', setting: 'on' });
    expect(out.ok).toBe(false); expect(out.blocking).toEqual([row]);
  });
  it('resolves the second key independently across all layers, failing closed', () => {
    const resolve = options => resolveMergeGateHoldSetting({ key, ...options });
    expect(resolve({})).toEqual({ value: 'on', source: 'standard' });
    expect(resolve({ platform: { mergeGate: { [key]: 'off' } } })).toEqual({ value: 'off', source: 'platform' });
    const platform = { mergeGate: { [key]: 'off' } }, repo = { mergeGate: { [key]: 'on' } };
    expect(resolve({ platform, repo })).toEqual({ value: 'on', source: 'repo' });
    expect(resolve({ platform, repo, env: { [envKey]: 'off' } })).toEqual({ value: 'off', source: 'env' });
    for (const layer of ['platform', 'repo', 'env']) {
      expect(resolve({ [layer]: layer === 'env' ? { [envKey]: 'bad' } : { mergeGate: { [key]: 'bad' } } })).toMatchObject({ value: 'off', source: layer });
    }
    expect(resolve({ platform: { mergeGate: { [key]: 'bad' } }, env: { [envKey]: 'on' } }).value).toBe('off');
    expect(resolve({ readErrors: ['unreadable'] }).value).toBe('off');
    expect(resolve({ repo: { mergeGate: { candidacyHoldIsNotCiFailure: 'off' } } })).toEqual({ value: 'on', source: 'standard' });
  });
  it('loads the new key and logs its effective source once', () => {
    const log = vi.fn();
    const options = { key, env: {}, readFile: () => '{}', readDeclared: () => ({ settings: { mergeGate: { [key]: 'off' } } }), log };
    expect(loadMergeGateHoldSetting(options)).toEqual({ value: 'off', source: 'repo' });
    loadMergeGateHoldSetting(options);
    expect(log.mock.calls).toEqual([['merge-gate · mergeGate.prEventCandidacyHoldsPass=off (source: repo)']]);
  });
});
