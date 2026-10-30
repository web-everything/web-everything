import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute, resolvePolicyModel, validateRoutingPolicy } from '../dispatch-routing-policy.mjs';
import { createRoutingPolicyReader } from '../dispatch-routing-policy-io.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { operatorPreferencesPath, readPlatformPreferences, PLATFORM_PREFERENCES_PATH, LEGACY_PLATFORM_PREFERENCES_PATHS } from '../policy-cascade.mjs';
import { resolveRoutingProviderCap } from '../../operations/review-seat-policy.mjs';
import { runExtraSeats, reserveSeatCalls } from '../../operations/review-extra-seats.mjs';
import { reviewSeatRoutes, ROUTED_ADVISORY_LENSES, EXTRA_JUROR_MANDATE } from '../../operations/review-dispatch.mjs';
import { decideDispatchRoute } from '../dispatch-contracts.mjs';
import { settingsFromRoutingPolicy } from '../review-seat-provider.mjs';

const key = 'review-seat:red-team';
const dirs = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'routing-overrides-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(realEvents = false) {
  const dir = temp(), path = join(dir, 'policy.json'), prefsPath = join(dir, 'preferences.json');
  const env = { WE_PLATFORM_PREFERENCES_FILE: prefsPath, WE_DAEMON_EVENTS: join(dir, 'events.jsonl') };
  writeFileSync(path, JSON.stringify(DEFAULT_ROUTING_POLICY));
  const log = vi.fn(), events = [], pending = [];
  const reader = createRoutingPolicyReader({ path, env, log, emit: event => {
    events.push(event); if (!realEvents) return true; const promise = appendDaemonEvent(event, { env }); pending.push(promise); return promise;
  } });
  const set = overrides => writeFileSync(prefsPath, JSON.stringify({ routingOverrides: overrides }));
  return { reader, set, log, events, pending, env, prefsPath };
}

describe('operator routing overrides', () => {
  it('refuses an inherited evidence route when provider disables cannot be enforced', () => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { fix: { disabledProviders: ['claude'] } });
    const result = decideDispatchRoute({ kind: 'fix', cause: 'review-finding', scopePaths: ['scripts/example.mjs'],
      size: 1, risk: 'low' }, { routingPolicy: policy, scorecards: [] });
    expect(result.outcome).toBe('refused');
    expect(result.refusal).toMatch(/routing policy/);
  });

  it.each(['advisory:agy-correctness', 'mandatory:correctness', 'mandatory:security'])(
    'rejects unsupported providers for %s before accepting an override', task => {
      for (const provider of ['codex', 'antigravity']) {
        expect(() => applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
          [`review-seat:${task}`]: { provider },
        })).toThrow(/provider/);
        expect(() => applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
          [`review-seat:${task}`]: { fallback: [{ provider: 'claude', model: 'sonnet' },
            { provider, model: provider === 'codex' ? 'sol' : 'sonnet' }] },
        })).toThrow(/provider/);
      }
    });

  it('rejects an unsupported generic review route when settings seats inherit it', () => {
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    for (const task of ['mandatory:correctness', 'mandatory:security', 'advisory:agy-correctness']) {
      delete base.operations[`review-seat:${task}`];
    }
    expect(() => applyRoutingOverrides(base, { 'review-seat': { provider: 'codex' } })).toThrow(/no available route/);
  });

  it('rejects disabling every mandatory seat provider before publishing settings', () => {
    expect(() => applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
      'review-seat:mandatory:correctness': { disabledProviders: ['agy-claude', 'claude'] },
    })).toThrow(/no available route/);
  });

  it('rejects disabling the counted Claude provider of a shadow seat', () => {
    expect(() => applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
      'review-seat:mandatory:correctness': { disabledProviders: ['claude'] },
    })).toThrow(/shadow requires an enabled claude provider/);
  });

  it.each([false, true])('enforces inherited task disables with gateClosed=%s', gateClosed => {
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    base.taskTypes.bugfix.disabledProviders = ['claude'];
    const policy = validateRoutingPolicy(base);
    expect(() => resolveOperationRoute({ operation: 'fix', taskType: 'bugfix', gateClosed, policy }))
      .toThrow(/disabled providers/);
  });

  it.each(['fix', 'ci-heal', 'review-seat:red-team'])(
    'never delegates constrained inherited %s routes to an unfiltered caller', operation => {
      const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { [operation]: { disabledProviders: ['codex'] } });
      expect(() => resolveOperationRoute({ operation, policy })).toThrow(/disabled providers/);
    });

  it.each(['red-team', 'standards-conformance', `extra-juror:${EXTRA_JUROR_MANDATE}`])(
    'delegates inherited %s selection only with candidates excluding every disabled provider', taskType => {
      const base = structuredClone(DEFAULT_ROUTING_POLICY);
      base.operations[`review-seat:${taskType}`] = { inherit: true };
      const policy = applyRoutingOverrides(base, { [`review-seat:${taskType}`]: {
        enabledProviders: ['agy-gemini'], disabledProviders: ['codex', 'agy-claude'],
      } });
      const options = { operation: 'review-seat', taskType, policy };
      expect(resolveOperationRoute({ ...options, available: ['agy-gemini'] })).toBeNull();
      expect(resolveOperationRoute({ ...options, available: [] })).toBeNull();
      for (const available of [undefined, ['codex', 'agy-gemini'], ['agy-claude', 'agy-gemini']]) {
        expect(() => resolveOperationRoute({ ...options, available })).toThrow(/disabled providers/);
      }
      expect(() => resolveOperationRoute({ ...options, available: ['agy-gemini'], gateClosed: true }))
        .toThrow(/disabled providers/);
      if (taskType !== 'red-team') {
        const plan = reviewSeatRoutes({ routingPolicy: policy, available: ['agy-gemini'] });
        expect(plan.routes.find(route => route.key === taskType)).toMatchObject({ provider: 'agy-gemini' });
      }
    });

  it.each(['fix', 'ci-heal', 'review-seat'])(
    'still refuses constrained inherited %s outside added seats even with filtered candidates', operation => {
      const base = structuredClone(DEFAULT_ROUTING_POLICY);
      const taskType = operation === 'review-seat' ? 'mandatory:correctness' : 'bugfix';
      base.operations[`${operation}:${taskType}`] = { inherit: true, disabledProviders: ['codex'] };
      expect(() => resolveOperationRoute({ operation, taskType, available: ['agy-gemini'], policy: base }))
        .toThrow(/disabled providers/);
    });

  it.each([
    { size: 1, designQuestion: false, wellScoped: true },
    { size: 5, designQuestion: true },
  ])('preserves operation disables across prepare route selection: %j', input => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { 'prepare-item': { disabledProviders: ['codex'] } });
    expect(resolveOperationRoute({ operation: 'prepare-item', policy, ...input }).provider).toBe('claude');
  });

  it('retains last good settings after an unsupported live advisory override and recovers on clear', () => {
    const f = fixture();
    const good = f.reader();
    f.set({ 'review-seat:advisory:agy-correctness': { provider: 'codex' } });
    expect(f.reader()).toBe(good);
    expect(() => settingsFromRoutingPolicy(f.reader())).not.toThrow();
    expect(f.log).toHaveBeenCalledTimes(1);
    f.set({});
    expect(() => settingsFromRoutingPolicy(f.reader())).not.toThrow();
  });

  it('keeps review initialization available when the optional advisory provider is disabled', () => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
      'review-seat:advisory:agy-correctness': { disabledProviders: ['agy-claude'] },
    });
    expect(settingsFromRoutingPolicy(policy).agyCorrectnessAdvisory).toBe(false);
  });

  it.each(['claude', 'agy-claude', 'agy-gemini'])('initializes review for a supported advisory provider %s', provider => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, {
      'review-seat:advisory:agy-correctness': { provider },
    });
    expect(settingsFromRoutingPolicy(policy).agyCorrectnessAdvisory).toBe(provider !== 'claude');
  });

  it('applies operation provider disables after resolving an inherited task-type route', () => {
    const policy = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { fix: { disabledProviders: ['codex'] } });
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'doc-fix', policy })).toMatchObject({
      provider: 'claude', fallback: [],
    });
    expect(() => resolveOperationRoute({ operation: 'fix', taskType: 'doc-fix', policy, available: ['codex'] }))
      .toThrow(/no available route/);
  });

  it('filters disabled inherited fallbacks while retaining task-type provider disables', () => {
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    base.taskTypes['doc-fix'] = { provider: 'agy-claude', model: 'sonnet', disabledProviders: ['agy-claude'],
      fallback: [{ provider: 'codex', model: 'sol' }, { provider: 'claude', model: 'sonnet' }] };
    const policy = applyRoutingOverrides(base, { fix: { disabledProviders: ['codex'] } });
    expect(resolveOperationRoute({ operation: 'fix', taskType: 'doc-fix', policy })).toMatchObject({
      provider: 'claude', fallback: [],
    });
  });

  it.each([[undefined, 300], ['0', 0], ['1', 1]])(
    'runs an overridden Gemini advisory seat with env cap %s, preserving the reservation bound', async (envCap, cap) => {
      const base = structuredClone(DEFAULT_ROUTING_POLICY);
      const seatKey = 'review-seat:standards-conformance';
      for (const task of [`extra-juror:${EXTRA_JUROR_MANDATE}`, ...ROUTED_ADVISORY_LENSES]) {
        base.operations[`review-seat:${task}`] = { provider: 'codex', model: 'sol', fallback: [] };
      }
      base.operations[seatKey] = { inherit: true };
      const policy = applyRoutingOverrides(base, { [seatKey]: { provider: 'agy-gemini', model: 'pro', fallback: [] } });
      const env = envCap === undefined ? {} : { WE_REVIEW_SEAT_CAP_AGY_GEMINI: envCap };
      const now = Date.parse('2026-10-30T12:00:00Z');
      let ledger = null;
      const io = {
        now: () => now, readRecords: () => [], log: vi.fn(), cliAvailable: p => p === 'agy-gemini',
        reserveCalls: vi.fn(options => {
          const reservation = reserveSeatCalls({ ...options, ledger, records: [], newId: () => 'advisory-call' });
          ledger = reservation.ledger;
          return reservation;
        }),
        makeScratch: () => temp(), removeScratch: vi.fn(), writeFile: vi.fn(), append: vi.fn(),
        runSeat: vi.fn(async () => ({ exitCode: 0, report: { events: { finalResponse: JSON.stringify({
          lenses: { 'standards-conformance': { verdict: 'accept', findings: [] } },
        }) } } })),
      };
      const input = { pr: 5, repo: 'test/repo', lanePath: temp(), env, routingPolicy: policy,
        loopPayload: { findings: { read: { diffText: 'diff --git a/x b/x\n+1\n', netBasis: { rev: 'a'.repeat(40) } } } } };
      const result = await runExtraSeats(input, io);
      expect(result.status).toBe(cap ? 'ran' : 'skipped');
      expect(result.providerUsage['agy-gemini'].cap).toBe(cap);
      if (cap) {
        expect(io.reserveCalls).toHaveBeenCalledWith(expect.objectContaining({ provider: 'agy-gemini', dailyCap: cap, want: 1 }));
        expect(io.runSeat).toHaveBeenCalledTimes(1);
        expect(io.runSeat).toHaveBeenCalledWith(expect.objectContaining({ provider: 'agy-gemini', model: 'gemini-3.1-pro' }));
        expect(result.seats).toContainEqual(expect.objectContaining({ lens: 'standards-conformance', provider: 'agy-gemini' }));
        if (cap === 1) {
          expect((await runExtraSeats(input, io)).status).toBe('skipped');
          expect(io.runSeat).toHaveBeenCalledTimes(1);
        }
      } else {
        expect(io.reserveCalls).not.toHaveBeenCalled();
        expect(io.runSeat).not.toHaveBeenCalled();
      }
    });

  it('merges effort leaves, replaces fallback order, and gives platform selection precedence over repo policy', () => {
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    base.operations[key] = { provider: 'codex', model: 'sol', effort: { codex: 'high', 'agy-gemini': 'low' }, fallback: [] };
    const policy = applyRoutingOverrides(base, { [key]: { provider: 'agy-gemini', model: 'pro', effort: { 'agy-gemini': 'high' },
      fallback: [{ provider: 'agy-claude', model: 'sonnet' }, { provider: 'codex', model: 'sol' }], disabledProviders: ['codex'] } });
    expect(policy.operations[key].effort).toEqual({ codex: 'high', 'agy-gemini': 'high' });
    expect(resolveOperationRoute({ operation: 'review-seat', taskType: 'red-team', policy })).toMatchObject({
      provider: 'agy-gemini', model: 'gemini-3.1-pro', effort: 'high', fallback: [{ provider: 'agy-claude', model: 'claude-sonnet-5-5-high' }],
    });
    expect(base.operations[key].provider).toBe('codex');
  });

  it.each([null, [], { typo: {} }, { [key]: { provider: 'unknown' } }, { [key]: { model: 'made-up' } },
    { [key]: { disabledProviders: ['typo'] } }, { [key]: { provider: 'codex', disabledProviders: ['codex'] } }])(
    'retains last good on invalid override and logs once: %j', invalid => {
      const f = fixture(); f.set({ [key]: { provider: 'agy-gemini' } });
      const good = f.reader(); f.set(invalid);
      expect(f.reader()).toBe(good); expect(f.reader()).toBe(good);
      expect(f.log).toHaveBeenCalledTimes(1); expect(f.events).toHaveLength(1);
    });

  it('deduplicates error signatures independently of policy signatures and resets after recovery', () => {
    const f = fixture(); f.set({ [key]: { provider: 'codex' } });
    const good = f.reader();
    f.set({ typo: {} });
    expect(f.reader()).toBe(good); expect(f.reader()).toBe(good);
    expect(f.log).toHaveBeenCalledTimes(1);
    f.set({ [key]: { provider: 'unknown' } });
    expect(f.reader()).toBe(good); expect(f.reader()).toBe(good);
    expect(f.log).toHaveBeenCalledTimes(2);
    f.set({ [key]: { provider: 'agy-gemini' } });
    const recovered = f.reader();
    expect(recovered.operations[key].provider).toBe('agy-gemini');
    expect(f.events).toHaveLength(2);
    f.set({ typo: {} });
    expect(f.reader()).toBe(recovered); expect(f.reader()).toBe(recovered);
    expect(f.log).toHaveBeenCalledTimes(3);
    expect(f.log.mock.calls[2]).toEqual(f.log.mock.calls[0]);
  });

  it('retains last good on unreadable or torn operator preferences, then recovers', () => {
    const f = fixture(); f.set({ [key]: { provider: 'codex' } }); const good = f.reader();
    writeFileSync(f.prefsPath, '{');
    expect(f.reader()).toBe(good); expect(f.reader()).toBe(good); expect(f.log).toHaveBeenCalledTimes(1);
    f.set({}); expect(f.reader().operations[key]).toEqual(DEFAULT_ROUTING_POLICY.operations[key]);
    const unreadable = createRoutingPolicyReader({ initial: good, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY), log: vi.fn(),
      preferences: () => ({ prefs: {}, errors: ['EACCES'] }) });
    expect(unreadable().operations[key].provider).toBe('codex');
  });

  it('reloads changes and clearing with one real JSONL event per operation change, never per pass', async () => {
    const f = fixture(true); f.reader();
    f.set({ [key]: { provider: 'agy-gemini' } });
    expect(f.reader().operations[key].provider).toBe('agy-gemini'); f.reader();
    f.set({ [key]: { provider: 'codex', model: 'sol' } });
    expect(f.reader().operations[key].provider).toBe('codex'); f.reader();
    f.set({}); expect(f.reader().operations[key]).toEqual(DEFAULT_ROUTING_POLICY.operations[key]); f.reader();
    await Promise.all(f.pending);
    const rows = readFileSync(f.env.WE_DAEMON_EVENTS, 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.detail.cleared).sort()).toEqual([false, false, true]);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'routing-override-applied', detail: expect.objectContaining({
      operation: 'review-seat', taskType: 'red-team', provider: 'agy-gemini', model: 'flash', source: 'platform', cleared: false,
    }) })]));
  });

  it('enables an unset default-zero provider with a finite cap and honours explicit disables', () => {
    const entry = applyRoutingOverrides(DEFAULT_ROUTING_POLICY, { [key]: { provider: 'agy-gemini' } }).operations[key];
    expect(resolveRoutingProviderCap('agy-gemini', {}, entry)).toBe(300);
    expect(resolveRoutingProviderCap('agy-gemini', { WE_REVIEW_SEAT_CAP_AGY_GEMINI: '7' }, entry)).toBe(7);
    expect(resolveRoutingProviderCap('agy-gemini', {}, DEFAULT_ROUTING_POLICY.operations[key])).toBe(0);
    expect(resolveRoutingProviderCap('codex', {}, { disabledProviders: ['codex'] })).toBe(0);
    expect(resolveRoutingProviderCap('codex', {}, { enabledProviders: ['codex'] })).toBe(80);
    expect(resolveRoutingProviderCap('agy-claude', {}, { enabledProviders: ['agy-claude'] })).toBe(300);
  });

  it.each([
    ['codex', 'WE_REVIEW_SEAT_CAP_CODEX'],
    ['agy-claude', 'WE_REVIEW_SEAT_CAP_AGY_CLAUDE'],
    ['agy-gemini', 'WE_REVIEW_SEAT_CAP_AGY_GEMINI'],
    ['codex', 'WE_REVIEW_EXTRA_SEATS_DAILY_CAP'],
  ])('preserves explicit zero and positive env caps when an override enables %s via %s', (provider, name) => {
    const entry = { enabledProviders: [provider] };
    expect(resolveRoutingProviderCap(provider, { [name]: '0' }, entry)).toBe(0);
    expect(resolveRoutingProviderCap(provider, { [name]: '7' }, entry)).toBe(7);
  });

  it('loads the existing operator file after repo platform defaults and supports an explicit replacement path', () => {
    const operator = operatorPreferencesPath({});
    const readFile = vi.fn(path => JSON.stringify(path === PLATFORM_PREFERENCES_PATH ? { routingOverrides: { repo: true }, other: 1 }
      : path === operator ? { routingOverrides: {} } : {}));
    const warn = vi.fn();
    expect(readPlatformPreferences({ env: {}, readFile, warn }).prefs).toEqual({ routingOverrides: {}, other: 1 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignoring routingOverrides'));
    expect(readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: 'operator.json' }, readFile: path => {
      expect(path).toBe('operator.json'); return '{"routingOverrides":{}}';
    } }).prefs).toEqual({ routingOverrides: {} });
  });

  it('uses effort-suffixed Sonnet aliases accepted by the agy catalog while accepting historical persisted ids', () => {
    for (const provider of ['agy-claude', 'antigravity']) {
      expect(resolvePolicyModel(provider, 'sonnet')).toBe('claude-sonnet-5-5-high');
      const policy = structuredClone(DEFAULT_ROUTING_POLICY);
      policy.operations[key] = { provider, model: policy.aliases[provider].sonnet, fallback: [] };
      expect(() => validateRoutingPolicy(policy)).not.toThrow();
      policy.aliases[provider].sonnet = 'claude-sonnet-5-5-unknown';
      expect(() => validateRoutingPolicy(policy)).toThrow(/unknown model/);
      expect(resolvePolicyModel(provider, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(resolvePolicyModel(provider, 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    }
  });

  it.each(['inherited', 'fallback'])('keeps a Gemini enable local to its seat when another seat uses an %s route', async routeKind => {
    const base = structuredClone(DEFAULT_ROUTING_POLICY);
    for (const task of [`extra-juror:${EXTRA_JUROR_MANDATE}`, ...ROUTED_ADVISORY_LENSES]) {
      base.operations[`review-seat:${task}`] = routeKind === 'inherited' ? { inherit: true }
        : { provider: 'codex', model: 'sol', fallback: [{ provider: 'agy-gemini', model: 'flash' }] };
    }
    const policy = applyRoutingOverrides(base, {
      'review-seat:standards-conformance': { provider: 'agy-gemini', model: 'pro', fallback: [] },
    });
    const io = {
      now: () => Date.parse('2026-10-30T12:00:00Z'), readRecords: () => [], log: vi.fn(),
      cliAvailable: p => p === 'agy-gemini',
      reserveCalls: vi.fn(options => reserveSeatCalls({ ...options, ledger: null, records: [], newId: () => 'local-enable' })),
      makeScratch: () => temp(), removeScratch: vi.fn(), writeFile: vi.fn(), append: vi.fn(),
      runSeat: vi.fn(async () => ({ exitCode: 0, report: { events: { finalResponse: JSON.stringify({
        lenses: { 'standards-conformance': { verdict: 'accept', findings: [] } },
      }) } } })),
    };
    const result = await runExtraSeats({ pr: 5, repo: 'test/repo', lanePath: temp(), env: {}, routingPolicy: policy,
      loopPayload: { findings: { read: { diffText: 'diff --git a/x b/x\n+1\n', netBasis: { rev: 'a'.repeat(40) } } } } }, io);
    expect(result.status).toBe('ran');
    expect(io.reserveCalls).toHaveBeenCalledTimes(1);
    expect(io.reserveCalls).toHaveBeenCalledWith(expect.objectContaining({ provider: 'agy-gemini', want: 1, dailyCap: 300 }));
    expect(io.runSeat).toHaveBeenCalledTimes(1);
    expect(result.seats.map(seat => seat.lens)).toEqual(['standards-conformance']);
    expect(result.skipped).toHaveLength(ROUTED_ADVISORY_LENSES.length);
  });

  it.each([PLATFORM_PREFERENCES_PATH, ...LEGACY_PLATFORM_PREFERENCES_PATHS])(
    'ignores and warns about repo routingOverrides in %s without preventing operator overrides', repoPath => {
      const operator = operatorPreferencesPath({}), warn = vi.fn();
      let operatorPresent = false;
      const preferences = () => readPlatformPreferences({ env: {}, warn, readFile: path => {
        if (path === repoPath) return JSON.stringify({ routingOverrides: { [key]: { provider: 'agy-gemini' } }, other: 1 });
        if (path === operator && operatorPresent) return JSON.stringify({ routingOverrides: { [key]: { provider: 'codex' } } });
        return '{}';
      } });
      expect(preferences().prefs).toEqual({ other: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${repoPath}: ignoring routingOverrides`));
      const reader = createRoutingPolicyReader({ preferences, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY), log: vi.fn(), emit: vi.fn() });
      expect(reader().operations[key]).toEqual(DEFAULT_ROUTING_POLICY.operations[key]);
      operatorPresent = true;
      expect(reader().operations[key].provider).toBe('codex');
      const replaced = readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: repoPath }, warn,
        readFile: () => JSON.stringify({ routingOverrides: { [key]: { provider: 'agy-gemini' } }, other: 1 }) });
      expect(replaced.prefs).toEqual({ other: 1 });
    });

  it.each(['throws synchronously', 'rejects'])('applies a validated policy when event emission %s', async failure => {
    const f = fixture();
    let onLog;
    const eventLogged = new Promise(resolve => { onLog = resolve; });
    const log = vi.fn(message => onLog(message));
    f.set({ [key]: { provider: 'agy-gemini' } });
    const emit = vi.fn(() => {
      if (failure === 'throws synchronously') throw new Error('event sink unavailable');
      return Promise.reject(new Error('event sink unavailable'));
    });
    const reader = createRoutingPolicyReader({ env: f.env, read: () => JSON.stringify(DEFAULT_ROUTING_POLICY), log, emit });
    const applied = reader();
    expect(applied.operations[key].provider).toBe('agy-gemini');
    await eventLogged;
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('routing-override-event: event sink unavailable');
    expect(reader()).toBe(applied);
    expect(emit).toHaveBeenCalledTimes(1);
    f.set({});
    const clearLogged = new Promise(resolve => { onLog = resolve; });
    expect(reader().operations[key]).toEqual(DEFAULT_ROUTING_POLICY.operations[key]);
    await clearLogged;
    expect(log).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
