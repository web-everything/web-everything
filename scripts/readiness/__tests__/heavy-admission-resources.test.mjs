/**
 * @file heavy-admission-resources.test.mjs — heavyAdmission.gate = load | shadow | resources (2026-10-20).
 * Live case: macOS load 30 on 12 cores (counts disk waits) while CPU was ~70% idle refused six test runs for 30+ min.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSlotBlocking, resolveAdmissionPolicy, tryAcquireSlot } from '../heavy-admission.mjs';
import { resourceVerdict, shadowLine, effectiveVerdict } from '../../lib/heavy-admission-resources.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const NOW = Date.parse('2026-10-20T21:00:00.000Z');
const snap = (o = {}) => ({
  sampledAt: new Date(NOW - 2000).toISOString(), freshUntil: new Date(NOW + 28_000).toISOString(),
  cpu: { idlePct: 70, cores: 12, loadAvg: [30, 30, 30], ...o.cpu },
  memory: { pressureLevel: 1, freePct: 25, swapUsedPct: 20, ...o.memory }, disk: { busyPct: 100 },
  heavySlots: { held: 0, cap: 3 },
});
const LEGACY_DEFER = { admitted: false, reason: 'host load 30.00/12=2.50; host.maxLoadPerCore=2 (standard)' };

async function run({ gate, host = LEGACY_DEFER, snapshot = snap(), cap = 3, preheld = 0 }) {
  const lockRoot = mkdtempSync(join(tmpdir(), 'heavy-res-')); roots.push(lockRoot);
  for (let i = 0; i < preheld; i++) {
    tryAcquireSlot({ lockRoot, cap, owner: `/x/.lanes/web-everything/lane-${i + 20}`, nowMs: NOW, nowIso: new Date(NOW).toISOString(), pid: process.pid });
  }
  const logs = [];
  let t = NOW; // fake clock: the fake sleep advances it, so the 1 ms ceiling is reached and nothing waits for real
  const policy = resolveAdmissionPolicy({ tool: { gate }, env: { LANE_POOL_ROOT: lockRoot } });
  const r = await acquireSlotBlocking({
    lockRoot, cap, owner: '/x/.lanes/web-everything/lane-3', policy, canDefer: true, interactive: false, env: {},
    hostAdmission: () => host, readResourceSnapshot: () => snapshot, log: (m) => logs.push(m), now: () => t, ceilingMs: 5,
    sleep: async (ms) => { t += Math.max(1, ms); }, pollMs: 1, stillWaitingLogMs: 1e12,
  });
  return { r, logs };
}

describe('resourceVerdict', () => {
  it('live case: load 30 but CPU 70% idle and memory free admits', () => {
    expect(resourceVerdict({ snapshot: snap(), nowMs: NOW })).toMatchObject({ verdict: 'admit', cpuIdlePct: 70, memFreePct: 25, swapUsedPct: 20 });
  });
  it('hard ceilings defer: low CPU idle, memory pressure above 2, low free memory, high swap', () => {
    expect(resourceVerdict({ snapshot: snap({ cpu: { idlePct: 10 } }), nowMs: NOW }).verdict).toBe('defer');
    expect(resourceVerdict({ snapshot: snap({ memory: { pressureLevel: 3 } }), nowMs: NOW }).verdict).toBe('defer');
    expect(resourceVerdict({ snapshot: snap({ memory: { freePct: 2 } }), nowMs: NOW }).verdict).toBe('defer');
    expect(resourceVerdict({ snapshot: snap({ memory: { swapUsedPct: 95 } }), nowMs: NOW }).verdict).toBe('defer');
  });
  it('fails closed (unknown) on missing, stale or partial snapshots', () => {
    expect(resourceVerdict({ snapshot: null, nowMs: NOW }).verdict).toBe(null);
    expect(resourceVerdict({ snapshot: snap(), nowMs: NOW + 120_000 }).verdict).toBe(null);
    expect(resourceVerdict({ snapshot: snap({ memory: { swapUsedPct: undefined } }), nowMs: NOW }).verdict).toBe(null);
    expect(effectiveVerdict({ gate: 'resources', legacy: 'defer', res: { verdict: null } })).toBe('defer');
  });
  it('shadowLine carries both verdicts and the numbers', () => {
    const res = resourceVerdict({ snapshot: snap(), nowMs: NOW });
    expect(shadowLine({ legacy: 'defer', legacyReason: LEGACY_DEFER.reason, res }))
      .toMatch(/^heavy-admission shadow: legacy=defer \(host load 30\.00\/12.*\) new=admit \(cpu idle 70%, mem free 25%, swap 20%/);
  });
});

describe('heavyAdmission.gate in acquireSlotBlocking', () => {
  it('standard gate is load: unchanged, no shadow line', async () => {
    expect(resolveAdmissionPolicy({ env: {} }).settings.gate).toBe('load');
    const { r, logs } = await run({ gate: 'load' });
    expect(r).toMatchObject({ ok: false, deferred: true });
    expect(logs.join('')).not.toMatch(/heavy-admission shadow/);
  });
  it('shadow: logs legacy=defer new=admit and still obeys the legacy defer', async () => {
    const { r, logs } = await run({ gate: 'shadow' });
    expect(r).toMatchObject({ ok: false, deferred: true });
    expect(logs.join('')).toMatch(/heavy-admission shadow: legacy=defer .* new=admit \(cpu idle 70%, mem free 25%/);
  });
  it('resources: live case admits and takes a slot', async () => {
    const { r, logs } = await run({ gate: 'resources' });
    expect(r.ok).toBe(true);
    expect(logs.join('')).toMatch(/legacy=defer .* new=admit/);
  });
  it('resources: real overload still defers', async () => {
    const { r } = await run({ gate: 'resources', snapshot: snap({ cpu: { idlePct: 8 } }) });
    expect(r).toMatchObject({ ok: false, deferred: true });
  });
  it('resources: unreadable or stale snapshot falls back to the legacy verdict', async () => {
    expect((await run({ gate: 'resources', snapshot: null })).r).toMatchObject({ ok: false, deferred: true });
    expect((await run({ gate: 'resources', snapshot: { ...snap(), freshUntil: new Date(NOW - 1).toISOString() } })).r).toMatchObject({ ok: false, deferred: true });
    expect((await run({ gate: 'resources', snapshot: null, host: { admitted: true, reason: 'ok' } })).r.ok).toBe(true);
  });
  it('resources never admits beyond the slot cap', async () => {
    const { r } = await run({ gate: 'resources', cap: 1, preheld: 1 });
    expect(r.ok).toBe(false);
  });
});
