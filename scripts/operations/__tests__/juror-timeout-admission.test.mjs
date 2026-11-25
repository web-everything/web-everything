import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultJudge, judgeOutcome, unwrapJudgeOutcome } from '../cli-adapter.mjs';
import { buildReviewJudgeRequest } from '../review-pr.mjs';
import { runSeatWithProvider } from '../review-seat-runner.mjs';
import { createExtraSeatsIo, reservationLedgerFileFor } from '../review-extra-seats.mjs';
import * as extraSeats from '../review-extra-seats.mjs';
import { jurorTimeoutRouteAvailable, jurorTimeoutRoutes, selectJurorTimeoutRoute } from '../../lib/review-seat-provider.mjs';
import * as policyIo from '../../lib/dispatch-routing-policy-io.mjs';
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';

const roots = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'timeout-admission-')); roots.push(root); return root; };
const answer = { summary: 'checked', findings: [] };
const route = { provider: 'agy-claude', model: 'claude-sonnet-5-5', effort: 'high' };
const request = { lens: 'security', mandate: 'judge', input: 'diff', shape: {}, allowedTools: ['Read'],
  budget: null, forbiddenVendor: 'OpenAI' };
function recovery(extra = {}) {
  const seatRunner = vi.fn(async () => judgeOutcome(answer));
  const provider = vi.fn(async () => ({ value: answer }));
  const checkProviderHold = vi.fn(async () => null);
  const judge = createDefaultJudge({ cwd: 'review-lane', providerName: 'claude', provider,
    jurorTimeoutExclusions: [{ lens: 'security', provider: 'claude' }], timeoutRoutes: () => [route],
    seatRunner, checkProviderHold, ...extra });
  return { judge, seatRunner, provider, checkProviderHold };
}
function liveReader() {
  const path = join(scratch(), 'policy.json');
  const write = policy => writeFileSync(path, JSON.stringify(policy));
  write(DEFAULT_ROUTING_POLICY);
  const reader = policyIo.createRoutingPolicyReader({ path, env: {}, preferences: () => ({ prefs: {}, errors: [] }),
    log: vi.fn(), emit: vi.fn() });
  const spy = vi.spyOn(policyIo, 'readRoutingPolicy').mockImplementation(options => reader(options));
  spy.operatorKeys = reader.operatorKeys;
  return { reader, path, write };
}

describe('round 1 finding 1: author vendor evidence', () => {
  it('the production daemon preflight holds legacy state with no author-vendor evidence', () => {
    expect(() => jurorTimeoutRouteAvailable({ exclusions: [{ lens: 'security', provider: 'claude' }] }))
      .toThrow(/author vendor.*orchestrator/i);
  });
  it('holds a production-built request whose author vendor is unknown, before selecting another author-vendor provider', async () => {
    const f = recovery();
    const built = buildReviewJudgeRequest({ read: { repo: 'o/r', pr: 1, title: 'fix', netChangedFiles: [], diffText: 'diff' }, lens: 'security' });
    await expect(f.judge(built)).rejects.toThrow(/author vendor.*orchestrator/i);
    expect(f.seatRunner).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
  it.each([undefined, null, '', 'unknown'])('holds missing or unrecognized author vendor %s', async forbiddenVendor => {
    const f = recovery();
    await expect(f.judge({ ...request, forbiddenVendor })).rejects.toThrow(/author vendor/i);
    expect(f.seatRunner).not.toHaveBeenCalled();
  });
  it('holds when the only replacement belongs to the known author vendor', async () => {
    const f = recovery();
    await expect(f.judge({ ...request, forbiddenVendor: 'Anthropic' })).rejects.toThrow(/no alternative/);
    expect(f.seatRunner).not.toHaveBeenCalled();
  });
});

describe('round 1 finding 2: advisory policy identity', () => {
  it('resolves agy-correctness through its normal advisory key and restrictions', () => {
    const f = liveReader();
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:advisory:agy-correctness'] = {
      provider: 'claude', model: 'sonnet', disabledProviders: ['agy-claude'], fallback: [] };
    f.write(policy);
    expect(jurorTimeoutRoutes('agy-correctness').map(r => r.provider)).toEqual(['claude']);
  });
  it('uses the advisory roster, which permits Claude, during selection too', () => {
    const claude = { provider: 'claude', model: 'claude-sonnet-5-5' };
    expect(selectJurorTimeoutRoute({ lens: 'agy-correctness', routes: [claude], forbiddenVendor: 'Google',
      exclusions: [{ lens: 'agy-correctness', provider: 'agy-claude' }] })).toEqual(claude);
  });
});

describe('round 1 finding 3: quota holds', () => {
  it('holds a selected agy replacement without fallback or advisory skip when quota is held', async () => {
    const checkProviderHold = vi.fn(async () => 'provider quota held');
    const f = recovery({ checkProviderHold });
    await expect(f.judge({ ...request, gracefulOnUnavailable: true })).rejects.toThrow(/provider quota held/);
    expect(checkProviderHold).toHaveBeenCalledWith('agy-claude', expect.any(Number), { strict: true });
    expect(f.seatRunner).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
  it('also checks holds for an ordinary Claude replacement', async () => {
    const provider = vi.fn();
    const f = recovery({ jurorTimeoutExclusions: [{ lens: 'security', provider: 'agy-claude' }],
      timeoutRoutes: () => [{ provider: 'claude', model: 'sonnet', effort: 'high' }],
      resolveProvider: () => provider, checkProviderHold: async () => 'Claude held' });
    await expect(f.judge(request)).rejects.toThrow(/Claude held/);
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('round 1 finding 4: counting seat cap and shared daily budget', () => {
  it('the seat runner reserves the shared budget before the counting juror runs', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '1');
    const reserveCalls = vi.fn(async () => ({ callIds: ['counting-seat'] }));
    const agyJuror = vi.fn(async () => {
      expect(reserveCalls).toHaveBeenCalledWith({ provider: 'agy-claude', want: 1, dailyCap: 1, now: expect.any(Number) });
      return { status: 'ok', sessionId: 'counting-juror', value: answer };
    });
    const f = recovery({
      seatRunner: (r, io) => runSeatWithProvider(r, { ...io, reserveCalls, agyJuror, log: vi.fn() }) });
    expect(unwrapJudgeOutcome(await f.judge(request)).value).toMatchObject(answer);
    expect(reserveCalls).toHaveBeenCalledTimes(1);
    expect(agyJuror).toHaveBeenCalledTimes(1);
  });
  it('the default reservation uses the shared ledger before invoking the counting juror', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '1');
    const reserveCalls = vi.fn(async () => ({ callIds: ['default-counting-seat'] }));
    const createIo = vi.spyOn(extraSeats, 'createExtraSeatsIo').mockReturnValue({ reserveCalls });
    const agyJuror = vi.fn(async () => {
      expect(reserveCalls).toHaveBeenCalledWith({ provider: 'agy-claude', want: 1, dailyCap: 1, now: expect.any(Number) });
      return { status: 'ok', sessionId: 'counting-juror', value: answer };
    });
    expect(unwrapJudgeOutcome(await run(route.model, undefined, agyJuror)).value).toMatchObject(answer);
    expect(createIo).toHaveBeenCalledTimes(1);
    expect(reserveCalls).toHaveBeenCalledTimes(1);
    expect(agyJuror).toHaveBeenCalledTimes(1);
  });
  it('an invalid reservation dependency holds before invoking the counting juror', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '1');
    const agyJuror = vi.fn();
    await expect(run(route.model, null, agyJuror)).rejects.toThrow(/daily seat budget unavailable/);
    expect(agyJuror).not.toHaveBeenCalled();
  });
  function run(model, reserveCalls, agyJuror) {
    return runSeatWithProvider({ ...request, seatProvider: { mode: 'agy', model, onEscape: 'refuse' } }, {
      claudeJudge: vi.fn(), unwrap: unwrapJudgeOutcome, wrap: judgeOutcome, cwd: 'review-lane',
      agyJuror, reserveCalls, log: vi.fn(),
    });
  }
  it('agy-Claude cap zero refuses before invoking the juror', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '0');
    const agyJuror = vi.fn(async () => ({ status: 'ok', sessionId: 's', value: answer }));
    await expect(run(route.model, vi.fn(), agyJuror)).rejects.toThrow(/agy-claude seat cap 0/);
    expect(agyJuror).not.toHaveBeenCalled();
  });
  it.each([['agy-claude', route.model, 'WE_REVIEW_SEAT_CAP_AGY_CLAUDE'],
    ['agy-gemini', 'gemini-3-pro', 'WE_REVIEW_SEAT_CAP_AGY_GEMINI']])(
    '%s cannot spend beyond reservations already held by normal seats', async (provider, model, envKey) => {
      vi.stubEnv(envKey, '1');
      const storePath = join(scratch(), 'scorecards.json');
      const io = createExtraSeatsIo({ storePath });
      expect(io.reserveCalls({ provider, want: 1, dailyCap: 1, now: Date.now() }).callIds).toHaveLength(1);
      const agyJuror = vi.fn(async () => ({ status: 'ok', sessionId: 's', value: answer }));
      await expect(run(model, io.reserveCalls, agyJuror)).rejects.toThrow(/daily.*budget|daily.*cap/);
      expect(agyJuror).not.toHaveBeenCalled();
    });
  it('an unreadable reservation ledger holds without launching', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '1');
    const root = scratch();
    writeFileSync(join(root, reservationLedgerFileFor('agy-claude')), '{');
    const io = createExtraSeatsIo({ storePath: join(root, 'scorecards.json') });
    const agyJuror = vi.fn(async () => ({ status: 'ok', sessionId: 's', value: answer }));
    await expect(run(route.model, io.reserveCalls, agyJuror)).rejects.toThrow(/daily.*budget/);
    expect(agyJuror).not.toHaveBeenCalled();
  });
  it('an unreadable usage scorecard holds without forgetting daily spend', async () => {
    vi.stubEnv('WE_REVIEW_SEAT_CAP_AGY_CLAUDE', '1');
    const storePath = join(scratch(), 'scorecards.json');
    writeFileSync(storePath, '{');
    const io = createExtraSeatsIo({ storePath });
    const agyJuror = vi.fn(async () => ({ status: 'ok', sessionId: 's', value: answer }));
    await expect(run(route.model, io.reserveCalls, agyJuror)).rejects.toThrow(/daily.*budget/);
    expect(agyJuror).not.toHaveBeenCalled();
  });
});

describe('round 1 finding 5: production policy retention', () => {
  it.each(['unreadable', 'malformed'])('recovery refuses a %s live policy even after a retained successful read', failure => {
    const f = liveReader();
    const good = f.reader();
    if (failure === 'unreadable') unlinkSync(f.path); else writeFileSync(f.path, '{');
    expect(f.reader()).toBe(good); // exercise the actual production last-good fallback
    expect(() => jurorTimeoutRoutes('security')).toThrow(/routing|policy/i);
  });
});

describe('round 1 finding 6: tool-free checkout isolation', () => {
  it('holds a diff-only Codex seat before the agy runner can clone its checkout', async () => {
    const f = recovery({ jurorTimeoutExclusions: [{ lens: 'quality', provider: 'codex' }] });
    const { allowedTools, ...toolFree } = request;
    await expect(f.judge({ ...toolFree, lens: 'quality', providerName: 'codex' })).rejects.toThrow(/checkout|tool-free/i);
    expect(f.seatRunner).not.toHaveBeenCalled(); expect(f.provider).not.toHaveBeenCalled();
  });
});

describe('round 1 finding 7: validated effort and spending constraints', () => {
  it.each([{ effort: '--unsafe' }, { budget: -1 }, { allowedTools: ['--unsafe'] }])(
    'validates the original request before replacing fields: %j', async invalid => {
      const f = recovery();
      await expect(f.judge({ ...request, ...invalid })).rejects.toThrow(/effort|budget|tool name/);
      expect(f.seatRunner).not.toHaveBeenCalled();
    });
  it('validates the selected route effort before invoking the agy runner', async () => {
    const f = recovery({ timeoutRoutes: () => [{ ...route, effort: '--unsafe' }] });
    await expect(f.judge(request)).rejects.toThrow(/effort/);
    expect(f.seatRunner).not.toHaveBeenCalled();
  });
  it('holds a finite spending ceiling that agy cannot enforce', async () => {
    const f = recovery();
    await expect(f.judge({ ...request, budget: 0.01 })).rejects.toThrow(/budget|spending ceiling/);
    expect(f.seatRunner).not.toHaveBeenCalled();
  });
  it('preserves the selected effort and explicit unlimited budget on an eligible replacement', async () => {
    const f = recovery();
    await f.judge({ ...request, effort: 'low' });
    expect(f.seatRunner.mock.calls[0][0]).toMatchObject({ model: route.model, effort: 'high', budget: null });
    expect(f.checkProviderHold).toHaveBeenCalledTimes(1);
  });
});

describe('round 3 finding 1: shadow fallback provenance', () => {
  it('holds after Claude times out when every remaining provider belongs to the validated shadow chain', async () => {
    const f = liveReader();
    const policy = structuredClone(DEFAULT_ROUTING_POLICY);
    policy.operations['review-seat:mandatory:security'] = {
      provider: 'agy-gemini', model: 'gemini-3.8-flash', mode: 'shadow',
      fallback: [{ provider: 'claude', model: 'sonnet' }, { provider: 'agy-claude', model: 'sonnet' }],
    };
    f.write(policy);
    expect(f.reader({ strict: true }).operations['review-seat:mandatory:security'].mode).toBe('shadow');
    const recovered = recovery({ timeoutRoutes: null });
    await expect(recovered.judge(request)).rejects.toMatchObject({
      reason: 'juror-timeout-no-alternative',
      message: expect.stringMatching(/no alternative.*orchestrator must restore an allowed provider/),
    });
    expect(recovered.seatRunner).not.toHaveBeenCalled();
    expect(recovered.provider).not.toHaveBeenCalled();
    const routes = jurorTimeoutRoutes('security');
    expect(routes.find(r => r.provider === 'agy-claude')).toMatchObject({ mode: 'shadow' });
    // Shadow provenance must still permit the chain's counting Claude fallback.
    expect(selectJurorTimeoutRoute({ lens: 'security', routes, forbiddenVendor: 'OpenAI',
      exclusions: [{ lens: 'security', provider: 'agy-gemini' }] }).provider).toBe('claude');
  });
});
