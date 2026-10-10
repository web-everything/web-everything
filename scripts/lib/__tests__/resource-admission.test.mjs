// @vitest-environment node
/** @file Shadow admission regressions: CPU idle wins over misleading load average. */
import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RESOURCE_POLICY_STANDARD, resolveResourcePolicy, loadResourcePolicy, decideAdmission, admit, shadowAdmission, resourcePaths } from '../resource-admission.mjs';
import { buildSnapshot, writeSnapshot } from '../resource-sampler.mjs';
const roots = [];
const temp = () => { const r = mkdtempSync(join(tmpdir(), 'admission-')); roots.push(r); return r; };
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const snapshot = (extra = {}) => buildSnapshot({ sampledAtMs: 100000, intervalMs: 10000, cpuIdlePct: 37, loadAvg: [63, 60, 50], memPressureLevel: 1, disk: { busyPct: 20 }, ...extra });
const decide = (s, kind = 'build', nowMs = 100000, policy = RESOURCE_POLICY_STANDARD) => decideAdmission({ kind, snapshot: s, nowMs, policy });
it('freezes standard and merges fields in cascade order', () => {
  expect(Object.isFrozen(RESOURCE_POLICY_STANDARD.build)).toBe(true);
  const policy = resolveResourcePolicy({ platform: { build: { minCpuIdlePct: 30, waitMinutes: 8 }, staleGraceMs: 100 }, tool: { build: { minCpuIdlePct: 20 } } });
  expect(policy.build).toMatchObject({ minCpuIdlePct: 20, waitMinutes: 8, maxDiskBusyPct: null });
  expect(policy.staleGraceMs).toBe(100);
  expect(RESOURCE_POLICY_STANDARD.build.minCpuIdlePct).toBe(15);
});
it('loads declared layers and reports malformed layers without applying them', () => {
  const root = temp(); mkdirSync(join(root, 'scripts')); mkdirSync(join(root, '.claude'));
  const platform = join(root, '.claude/platform-preferences.json');
  const tool = join(root, 'scripts/dispatch-settings.json');
  writeFileSync(platform, JSON.stringify({ resourceAdmission: { build: { minCpuIdlePct: 30 } } }));
  writeFileSync(tool, JSON.stringify({ resourceAdmission: { build: { waitMinutes: 3 } } }));
  const load = () => loadResourcePolicy({ env: {}, repoRoot: root, home: root });
  expect(load().policy.build).toMatchObject({ minCpuIdlePct: 30, waitMinutes: 3 });
  expect(load().sources).toMatchObject({ platform, tool });
  writeFileSync(tool, '{');
  expect(load().sources.errors).toHaveLength(1);
  expect(load().policy.build.minCpuIdlePct).toBe(30);
  writeFileSync(platform, JSON.stringify({ resourceAdmission: { build: { minCpuIdlePct: 'bad' } } }));
  expect(load().policy.build.minCpuIdlePct).toBe(15);
  expect(load().sources.errors).toHaveLength(2);
});
it('admits high load with idle CPU for every kind and unknown kinds', () => {
  for (const kind of ['build', 'prepare', 'fix', 'ci-heal', 'review', 'rebuild-smoke', 'load-flake-rearm', 'light', 'other']) {
    expect(decide(snapshot(), kind)).toMatchObject({ verdict: 'admit', unknown: false, inputs: { loadAvg1: 63 } });
  }
});
it('handles missing, stale, boundary freshness and grace', () => {
  expect(decide(null)).toMatchObject({ verdict: 'hold', unknown: true, reason: 'snapshot-missing', snapshotAge: null });
  expect(decide(null, 'prepare').verdict).toBe('admit');
  expect(decide(snapshot(), 'build', 130001)).toMatchObject({ verdict: 'hold', unknown: true });
  expect(decide(snapshot(), 'light', 130001).verdict).toBe('admit');
  expect(decide(snapshot(), 'build', 130000).unknown).toBe(false);
  expect(decide(snapshot(), 'build', 130001, resolveResourcePolicy({ tool: { staleGraceMs: 100 } })).unknown).toBe(false);
});
it('applies memory, cpu, disk and optional slot limits with null diagnostics', () => {
  expect(decide(snapshot({ memPressureLevel: 4, cpuIdlePct: 0 }))).toMatchObject({ verdict: 'hold', projectedWaitMinutes: 2 });
  expect(decide(snapshot({ cpuIdlePct: 14 }))).toMatchObject({ verdict: 'wait', projectedWaitMinutes: 2 });
  // disk is record-only by default (100% busy on an idle-CPU afternoon); an override turns it into a limit
  expect(decide(snapshot({ disk: { busyPct: 100 } })).verdict).toBe('admit');
  const diskPolicy = resolveResourcePolicy({ tool: { build: { maxDiskBusyPct: 95 } } });
  expect(decide(snapshot({ disk: { busyPct: 96 } }), 'build', 100000, diskPolicy).verdict).toBe('wait');
  expect(decide(snapshot({ disk: { busyPct: 100 } }), 'prepare').verdict).toBe('admit');
  expect(decide(snapshot({ cpuIdlePct: 15, memPressureLevel: 2, disk: { busyPct: 95 } })).verdict).toBe('admit');
  const result = decide(snapshot({ cpuIdlePct: null, memPressureLevel: null, disk: null }));
  expect(result.verdict).toBe('admit');
  expect(result.reason).toMatch(/cpu.*unknown.*memory.*unknown.*disk.*unknown/);
  const policy = resolveResourcePolicy({ tool: { build: { maxHeavySlotsHeldPct: 50 } } });
  expect(decide(snapshot({ heavySlots: { held: 2, cap: 3 } }), 'build', 100000, policy).verdict).toBe('wait');
});
it('writes shadow JSONL and a human line; off skips and logging cannot throw', () => {
  const root = temp(); writeSnapshot(snapshot(), { root });
  const lines = [];
  expect(shadowAdmission({ gate: 'test', kind: 'build', oldVerdict: 'hold', oldReason: 'load', root, nowMs: 100000, log: s => lines.push(s) }).verdict).toBe('admit');
  expect(lines).toHaveLength(1); expect(lines[0]).toContain('new verdict: admit');
  expect(JSON.parse(readFileSync(resourcePaths(root).shadow, 'utf8'))).toMatchObject({ gate: 'test', agree: false, new: { verdict: 'admit', unknown: false } });
  shadowAdmission({ root, env: { WE_RESOURCE_SHADOW: 'off' }, log: () => { throw Error('must skip'); } });
  const blocked = join(root, 'file'); writeFileSync(blocked, 'not a directory');
  expect(() => shadowAdmission({ root: blocked, kind: 'build', log: () => { throw Error('closed'); } })).not.toThrow();
});
it('always audits unknown admission even with shadow disabled', () => {
  const root = temp();
  expect(admit({ root, kind: 'build', nowMs: 100000, env: { WE_RESOURCE_SHADOW: 'off' } }).unknown).toBe(true);
  expect(JSON.parse(readFileSync(resourcePaths(root).shadow, 'utf8')).new.unknown).toBe(true);
});
