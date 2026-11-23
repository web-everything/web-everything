import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultJudge, judgeOutcome, unwrapJudgeOutcome } from '../../operations/cli-adapter.mjs';
import { runSeatWithProvider } from '../../operations/review-seat-runner.mjs';
import { independentReviewRequest, isIndependentReviewSeat } from '../review-seat-independence.mjs';
import { resolveBuilder } from '../review-builder.mjs';
import { buildDelegationMarker } from '../delegation-marker.mjs';
import { loadReviewSeatSettings, seatProviderDirective } from '../review-seat-provider.mjs';
import { DEFAULT_ROUTING_POLICY } from '../dispatch-routing-policy.mjs';

const carbon = 'gemini-4-carbon-high';
const context = { repo: 'o/r', pr: 7337, head: 'a'.repeat(40) };
const marker = (provider, model) => buildDelegationMarker({ provider, model, taskType: 'bugfix' });
const clean = { summary: 'Inspected', findings: [] };
afterEach(() => vi.unstubAllEnvs());

describe('Carbon promotion audit trust boundaries', () => {
  it.each(['correctness', 'security', 'red-team'])('missing CLI-observed model fails %s, records failure and permits only an independent fallback', async lens => {
    const calls = [], rows = [];
    let served = false;
    const judge = createDefaultJudge({ readBuilderRecords: () => [], appendSeat: row => { rows.push(row); return true; },
      seatRunner: async () => { calls.push('carbon'); return judgeOutcome(clean); },
      resolveProvider: name => async () => { calls.push(name); return { value: clean, ...(served ? { servedModel: 'gpt-6.1-sol' } : {}) }; },
    });
    const request = { lens, mandate: 'Review', input: 'diff', shape: { type: 'object' },
      seatProvider: { mode: 'agy', promoted: true, model: carbon },
      reviewContext: { ...context, body: marker('claude', 'claude-sonnet-5-5') } };
    // Exercise the actual telemetry producer too: the requested model must not count as observed.
    await expect(judge(request)).rejects.toThrow(/WAIT: observed reviewer model/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', agyVerdict: null });
    const fallback = independentReviewRequest(request, 'claude', ['claude', 'codex']);
    expect(isIndependentReviewSeat(lens, fallback.providerName, 'claude')).toBe(true);
    await expect(judge(fallback)).rejects.toThrow(/WAIT: observed reviewer model/);
    expect(rows[1]).toMatchObject({ status: 'failed', agyVerdict: null });
    served = true;
    expect(unwrapJudgeOutcome(await judge(fallback)).value).toEqual(clean);
    expect(calls).toEqual(['carbon', 'codex', 'codex']);
    expect(rows[2]).toMatchObject({ status: 'ok', provider: 'codex' });
  });

  it.each(['promoted', 'promotionReplaces', 'shadowEnabled', 'same-vendor'])('rechecks %s after planning and refuses the counted Carbon launch', async change => {
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'true');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'claude');
    vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '1');
    const settings = loadReviewSeatSettings({ policy: DEFAULT_ROUTING_POLICY, aiRouting: {}, log: () => {} });
    const directive = seatProviderDirective(settings, 'correctness', context);
    expect(directive).toMatchObject({ mode: 'agy', promoted: true, model: carbon });
    const request = { lens: 'correctness', reviewBuilder: change === 'same-vendor' ? carbon : 'claude', seatProvider: directive };
    if (change === 'promoted') vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTED', 'false');
    if (change === 'promotionReplaces') vi.stubEnv('WE_REVIEW_SHADOW_AGY_PROMOTION_REPLACES', 'codex');
    if (change === 'shadowEnabled') vi.stubEnv('WE_REVIEW_SHADOW_AGY_ENABLED', '0');
    const agyJuror = vi.fn(), rows = [];
    const answer = await runSeatWithProvider(request, { cwd: '.', unwrap: x => x, wrap: value => value,
      claudeJudge: async () => ({ value: { summary: 'Independent fallback found a defect', findings: [{ severity: 'P1' }] } }),
      agyJuror, appendPromotion: row => { rows.push(row); return true; }, log: () => {},
    });
    expect(agyJuror).not.toHaveBeenCalled();
    expect(answer.seatProvider.provider).toBe('claude');
    expect(answer.seatProvider.fellBackFrom).toMatchObject({ status: 'failed', reasons: [expect.stringMatching(/live Carbon promotion/)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].fallback).toBe(true);
  });

  it.each(['head', 'rev', 'headSha'])('historical builds cannot invalidate the current revision builder recorded by %s', async revisionField => {
    const current = { repo: context.repo, pr: context.pr, dispatchKind: 'build',
      [revisionField]: context.head, provider: 'codex', model: 'gpt-6.1-sol' };
    const historical = { ...current, [revisionField]: 'b'.repeat(40), provider: 'claude', model: 'claude-sonnet-5-5' };
    const readRecords = () => [historical, current];
    const reviewContext = { ...context, body: marker(current.provider, current.model) };
    expect(resolveBuilder(reviewContext, { readRecords })).toMatchObject({ provider: current.provider, model: current.model, source: 'dispatch-ledger' });
    const calls = [];
    const judge = createDefaultJudge({ readBuilderRecords: readRecords, appendSeat: () => true,
      resolveProvider: name => async () => { calls.push(name); return { value: clean, servedModel: 'claude-sonnet-5-5' }; },
    });
    expect(unwrapJudgeOutcome(await judge({ lens: 'red-team', providerName: 'codex', mandate: 'Review', input: 'diff', shape: { type: 'object' }, reviewContext })).value).toEqual(clean);
    expect(calls).toEqual(['claude']);
  });

  it.each(['missing-reviewed-head', 'unversioned-ledger'])('holds incomplete revision evidence: %s', kind => {
    const { head, ...withoutHead } = context;
    const review = kind === 'missing-reviewed-head' ? withoutHead : context;
    const record = { ...withoutHead, dispatchKind: 'build', provider: 'codex', model: 'gpt-6.1-sol',
      ...(kind === 'missing-reviewed-head' ? { rev: head } : {}) };
    expect(resolveBuilder({ ...review, body: marker('claude', 'claude-sonnet-5-5') }, { readRecords: () => [record] }))
      .toMatchObject({ provider: 'unknown', model: 'unknown' });
  });

  it.each(['forged', 'disagrees', 'ledger-only', 'unreadable'])('uses the dispatch ledger and holds %s identity instead of admitting a same-vendor reviewer', async kind => {
    const ledger = { ...context, provider: 'codex', model: 'gpt-6.1-sol', dispatchKind: 'build' };
    const body = kind === 'forged' ? marker('claude', 'gpt-6.1-sol') : kind === 'ledger-only' ? '' : marker('claude', 'claude-sonnet-5-5');
    const readRecords = () => { if (kind === 'unreadable') throw new Error('ledger unavailable'); return [ledger]; };
    const identity = resolveBuilder({ ...context, body }, { readRecords });
    expect(identity).toMatchObject(kind === 'ledger-only' ? { provider: 'codex', source: 'dispatch-ledger' } : { provider: 'unknown', model: 'unknown' });
    expect(isIndependentReviewSeat('red-team', 'codex', identity.model)).toBe(false);
    const provider = vi.fn();
    const judge = createDefaultJudge({ readBuilderRecords: readRecords, resolveProvider: () => provider, appendSeat: () => true });
    if (kind !== 'ledger-only') await expect(judge({ lens: 'red-team', providerName: 'codex', reviewContext: { ...context, body } })).rejects.toThrow(/WAIT/);
    expect(provider).not.toHaveBeenCalled();
  });
});
