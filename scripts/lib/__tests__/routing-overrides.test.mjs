import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute, resolvePolicyModel } from '../dispatch-routing-policy.mjs';
import { createRoutingPolicyReader } from '../dispatch-routing-policy-io.mjs';
import { appendDaemonEvent } from '../daemon-events.mjs';
import { operatorPreferencesPath, readPlatformPreferences, PLATFORM_PREFERENCES_PATH } from '../policy-cascade.mjs';
import { resolveRoutingProviderCap } from '../../operations/review-seat-policy.mjs';
import { runExtraSeats, reserveSeatCalls } from '../../operations/review-extra-seats.mjs';
import { ROUTED_ADVISORY_LENSES, EXTRA_JUROR_MANDATE } from '../../operations/review-dispatch.mjs';

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
      provider: 'agy-gemini', model: 'gemini-3.1-pro', effort: 'high', fallback: [{ provider: 'agy-claude', model: 'claude-sonnet-5-5' }],
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
    expect(readPlatformPreferences({ env: {}, readFile }).prefs).toEqual({ routingOverrides: {}, other: 1 });
    expect(readPlatformPreferences({ env: { WE_PLATFORM_PREFERENCES_FILE: 'operator.json' }, readFile: path => {
      expect(path).toBe('operator.json'); return '{"routingOverrides":{}}';
    } }).prefs).toEqual({ routingOverrides: {} });
  });

  it('uses current Sonnet aliases while accepting historical persisted ids', () => {
    for (const provider of ['agy-claude', 'antigravity']) {
      expect(resolvePolicyModel(provider, 'sonnet')).toBe('claude-sonnet-5-5');
      expect(resolvePolicyModel(provider, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    }
  });
});
