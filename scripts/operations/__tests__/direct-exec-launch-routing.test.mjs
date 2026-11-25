/** Real dispatch sites and route guard; only process launch and host IO are injected. */
import { describe, it, expect, vi } from 'vitest';
import { createDispatchSinks, defaultClaudeProvider, routeDispatchProvider } from '../dispatch-lane-io.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { dispatchReview } from '../review-dispatch.mjs';
import { launchWrappedClaudeWorker } from '../worker-wrapper-launch.mjs';
import { dispatchFix } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { claudeLaunchRouteFor, checkClaudeLaunchRoute } from '../../lib/dispatch-routing-policy.mjs';
import { advance, startRun } from '../engine.mjs';
import { applyPendingEffects, inFlightEntries } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { createRegistry, op } from '../registry.mjs';
import { effect } from '../step-kinds.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';
const request = { sessionId, sessionSlug: 'ci-heal-42', launchKind: 'ci-heal', repo: 'frontierui',
  pr: 42, prompt: 'Repair the failed CI', cwd: '/unused', advisorFor: () => ({ reason: 'kind-not-in-trial' }) };
const providerWith = launchWrapped => r => defaultClaudeProvider(r, { wrapKind: () => true, launchWrapped });
const realWrapper = launch => options => launchWrappedClaudeWorker({ ...options, launch });
const reviewOptions = {
  pr: 42, repo: 'web-everything/web-everything', root: '/repo', expectedHead: 'a'.repeat(40),
  io: { liveHead: () => 'a'.repeat(40) }, ciGate: () => ({ allowed: true }),
  checkStaleness: () => ({ fresh: true, behind: 0 }), readBrief: () => 'Review {{PR}}',
  mintSessionId: () => sessionId, sessionCwdFor: () => '/unused', ensureSessionCwd: p => p,
  resolveSettingsEnv: () => null, isolateSession: () => ({}), wrapReview: true,
};
const planned = { pr: 42, itemNum: '42', lane: 2, laneRef: 'lane/42-x', scope: ['we:scripts/build-docs.mjs'] };
const fixOptions = () => ({ root: '/repo', readBrief: () => '{{PR_NUM}} {{LANE_REF}}',
  readFixClaim: () => null, acquireClaim: () => ({ ok: true }), releaseClaim: vi.fn(),
  stampExecutor: vi.fn(), stampRunner: vi.fn(), postNotice: vi.fn(),
  sessionCwdFor: () => '/unused', ensureSessionCwd: p => p, grantConflictHelper: vi.fn(),
  isolateSession: () => ({}), resolveSettingsEnv: () => null,
  advisorFor: () => ({ enabled: false, reason: 'kind-not-in-trial' }), recordAdvisor: vi.fn(), wrapFix: true,
});

describe('real wrapped Claude routing at dispatch boundaries', () => {
  it.each([
    ['unrouted fix', { launchKind: 'fix', sessionSlug: 'fix-42', policyRoute: null, table: null }],
    ['sibling CI heal', { policyRoute: null, table: null }],
    ['operator pin', { policyRoute: null, table: null, extraArgs: ['--model', 'opus'], modelReason: 'operator request' }],
    ['inherited tier', { table: { model: 'sonnet', reason: 'tier' } }],
    ['selected Claude policy', { policyRoute: { provider: 'claude', model: 'claude-sonnet-5-5', fallback: [] } }],
  ])('%s starts through the real guard', (_name, shape) => {
    const launch = vi.fn(() => ({ wrapperPid: 7 }));
    expect(providerWith(realWrapper(launch))({ ...request, ...shape })).toBe('pid:7');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].route.provider).toBe('claude');
  });

  it.each(['codex', 'agy-claude'])('table model cannot hide a resolved %s route', provider => {
    const launch = vi.fn();
    expect(() => providerWith(realWrapper(launch))({ ...request,
      table: { model: 'sonnet' }, policyRoute: { provider, fallback: [{ provider: 'claude' }] },
    })).toThrow(/route-mismatch/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('a configured fallback is refused until the router actually selects Claude', () => {
    const policyRoute = { provider: 'codex', model: 'gpt-6-astra', fallback: [{ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }] };
    expect(checkClaudeLaunchRoute(claudeLaunchRouteFor({ policyRoute })).ok).toBe(false);
    const launch = vi.fn(() => ({ wrapperPid: 8 }));
    expect(routeDispatchProvider({ ...request, policyRoute }, {
      agent: providerWith(realWrapper(launch)), modes: { 'ci-heal': 'agent' },
      registry: {}, providerAvailable: provider => provider === 'claude',
    })).toBe('pid:8');
    expect(launch.mock.calls[0][0].route).toEqual({ provider: 'claude', fallbackProvider: null, reason: 'routing-policy' });
  });

  it.each(['codex', 'antigravity'])('wrapped %s task starts one Claude supervisor through the real guard', executor => {
    const launch = vi.fn(() => ({ wrapperPid: 9 }));
    const opts = fixOptions();
    const result = dispatchFix(planned, { ...opts, launchWrapped: realWrapper(launch),
      executorDecision: { executor, mode: 'wrapped', policyRoute: { provider: executor } },
    });
    expect(result.agentId).toBe('pid:9');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].route).toEqual({ provider: 'claude', fallbackProvider: null,
      reason: `wrapped ${executor} task: Claude supervisor` });
    expect(launch.mock.calls[0][0].argv.at(-1)).toContain(`${executor === 'codex' ? 'codex' : 'gemini'}-direct-task`);
    expect(opts.stampRunner).toHaveBeenCalledWith(expect.objectContaining({ pid: 9 }));
  });

  it.each(['claude', 'antigravity'])('review with a %s juror starts its Claude supervisor and records the route', judgeProvider => {
    const launch = vi.fn(() => ({ wrapperPid: 10 }));
    expect(dispatchReview({ ...reviewOptions, judgeProvider, launchWrapped: realWrapper(launch) }).agentId).toBe('pid:10');
    expect(launch).toHaveBeenCalledOnce();
    expect(launch.mock.calls[0][0].route.provider).toBe('claude');
  });
  it.each(['codex', 'agy-claude'])('review refuses a resolved %s policy even with a Claude tier table', provider => {
    const launch = vi.fn();
    expect(() => dispatchReview({ ...reviewOptions, launchWrapped: realWrapper(launch),
      resolveRoute: () => ({ provider, fallback: [{ provider: 'claude' }] }),
    })).toThrow(/route-mismatch/);
    expect(launch).not.toHaveBeenCalled();
  });
  it('the default provider resolves policy even when the request has only a model table', () => {
    const launch = vi.fn();
    expect(() => defaultClaudeProvider({ ...request, table: { model: 'sonnet' } }, {
      wrapKind: () => true, launchWrapped: realWrapper(launch), resolveRoute: () => ({ provider: 'codex' }),
    })).toThrow(/route-mismatch/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('refusals are proven not started at every site', () => {
  const refusal = { refused: 'route-mismatch: refused by guard', handle: 'refused:route-mismatch', wrapperPid: null };
  it.each(['guard', 'smoke sentinel'])('the lane sink releases its reservation for a %s refusal', async kind => {
    const releaseLane = vi.fn();
    const sinks = createDispatchSinks({ root: '/repo', mintSessionId: () => sessionId,
      reserveLane: () => ({ reserved: true, lane: 2, session: 'ci-heal-42' }), releaseLane,
      sessionCwdFor: () => '/unused', ensureSessionCwd: p => p, resolveSettingsEnv: () => null,
      resolveLaneGrant: () => ({}), grantLanePermission: vi.fn(), ensureWorktreeIsolation: vi.fn(),
      provider: providerWith(() => ({ ...refusal, refused: `${kind}: refused by guard` })),
    });
    await expect(sinks[DISPATCH_EFFECT]({ ...request, lane: 2, routing: null })).rejects.toMatchObject({ notApplied: true });
    expect(releaseLane).toHaveBeenCalledWith({ reserved: true, lane: 2, session: 'ci-heal-42' });
    const registry = createRegistry();
    registry.register(op('refused-launch', { launch: effect({ effects: () => [{
      type: DISPATCH_EFFECT, dispatch: true, payload: { ...request, lane: 2, routing: null },
    }] }) }));
    const run = advance(startRun({ op: 'refused-launch', id: 'refused-launch', registry }), { registry });
    const store = createMemoryRunStore();
    store.write(run);
    const result = await applyPendingEffects(run, { store, sinks });
    expect(result.error).toMatchObject({ notApplied: true });
    expect(store.read(run.id).effects[0].status).toBe('failed');
    expect(inFlightEntries(store.read(run.id))).toEqual({ running: [], overdue: [], unknown: [] });
  });
  it('review rejects a returned refusal instead of reporting a started worker', () => {
    expect(() => dispatchReview({ ...reviewOptions, launchWrapped: () => refusal })).toThrow(/refused by guard/);
    try { dispatchReview({ ...reviewOptions, launchWrapped: () => refusal }); }
    catch (e) { expect(e.notApplied).toBe(true); }
  });
  it('fix rejects a returned refusal, releases the claim and voids an unstarted takeover', () => {
    const opts = fixOptions();
    const postTakeover = vi.fn(), postTakeoverVoidMark = vi.fn();
    expect(() => dispatchFix({ ...planned, takeover: { n: 1, budget: 1 }, headRefOid: 'a'.repeat(40) }, {
      ...opts, executorDecision: { executor: 'claude' }, launchWrapped: () => refusal,
      postTakeover, postTakeoverVoidMark,
    })).toThrow(/refused by guard/);
    expect(opts.stampRunner).not.toHaveBeenCalled();
    expect(opts.releaseClaim).toHaveBeenCalledOnce();
    expect(postTakeover).toHaveBeenCalledOnce();
    expect(postTakeoverVoidMark).toHaveBeenCalledOnce();
  });
});
