import { it, expect, vi } from 'vitest';
import { resolve } from 'node:path';
import smell from '../health-smells/stale-code-service.mjs';
import { runHealthTick, emptyHealthState, episodeKey } from '../health-watch-core.mjs';
import { cloneKey } from '../../lib/daemon-overlays.mjs';
import { validateSmellShape } from '../health-smells-shape.mjs';
it('stale-code-service is discoverable using an existing probe', () => {
  expect(() => validateSmellShape(smell, 'stale-code-service.mjs')).not.toThrow();
  expect(smell.probes).toEqual(['selfSync']);
});
it('stale flag true/false and unreadable plist require operator action', () => {
  const cloneRoot = resolve('fixtures/clone');
  const findStale = vi.fn(() => [{ label: 'com.we.sampler', plistPath: 'sampler.plist', reason: 'stale-code' }, { label: null, plistPath: 'bad.plist', reason: 'plist-unreadable' }]);
  const rows = smell.evaluate({ cloneLag: [{ cloneRoot }] }, { findStaleCodeServices: findStale, listCloneRoots: () => [cloneRoot] });
  expect(findStale).toHaveBeenCalledWith({ cloneRoot, onFreshService: expect.any(Function) }); expect(rows).toHaveLength(3);
  expect(rows.map(row => row.breach)).toEqual([false, true, true]);
  expect(rows[0].subject).toBe(`clone:${cloneRoot}:service:unknown`);
  expect(rows.slice(1).map(row => row.measure.reason)).toEqual(['stale-code', 'plist-unreadable']);
  expect(rows[2].recommendation).toMatch(/plist|inspect/i);
  expect(smell.evaluate({ cloneLag: [{ cloneRoot }] }, { findStaleCodeServices: () => [], listCloneRoots: () => [cloneRoot] })[0].breach).toBe(false);
});
it('reader failure flags an operator-visible fallback', () => {
  const rows = smell.evaluate({ cloneLag: [{ cloneRoot: resolve('fixtures/clone') }] }, { findStaleCodeServices: () => { throw new Error('cannot inspect'); }, listCloneRoots: () => [resolve('fixtures/clone')] });
  expect(rows[0].breach).toBe(true); expect(rows[0].recommendation).toMatch(/inspect/i);
});

function episodeFixture() {
  const cloneRoot = resolve('fixtures/overlay-clone');
  let roots = [cloneRoot], mode = 'stale';
  const inspect = vi.fn(({ onFreshService }) => {
    if (mode === 'fresh') { onFreshService({ label: 'com.we.sampler', plistPath: 'sampler.plist' }); return []; }
    return [{ label: 'com.we.sampler', plistPath: 'sampler.plist', reason: 'stale-code' }];
  });
  const descriptor = { ...smell, evaluate(probes, ctx) {
    return smell.evaluate(probes, { ...ctx, listCloneRoots: () => roots, findStaleCodeServices: inspect });
  } };
  validateSmellShape(descriptor, 'stale-code-service.mjs');
  const selfSync = [{ cloneKey: cloneKey(cloneRoot), alerts: [], rebuild: { adopted: { at: 1000, head: 'overlay-head' } } }];
  const initial = runHealthTick(emptyHealthState(), { selfSync, cloneLag: [{ cloneRoot }] }, [descriptor], 1000);
  const key = episodeKey(smell.id, `clone:${cloneRoot}:service:com.we.sampler`);
  expect(initial.state.episodes[key]?.status).toBe('open');
  return { cloneRoot, inspect, descriptor, selfSync, initial, key,
    setRoots: value => { roots = value; }, setMode: value => { mode = value; } };
}
it('overlay clone omitted from cloneLag is inspected through independent managed roots and keeps its real episode open', () => {
  const f = episodeFixture();
  const next = runHealthTick(f.initial.state, { selfSync: f.selfSync, cloneLag: [] }, [f.descriptor], 2000);
  expect(f.inspect).toHaveBeenCalledTimes(2);
  expect(next.state.episodes[f.key]?.status).toBe('open');
  expect(next.transitions.some(t => t.type === 'closed')).toBe(false);
});
it('unknown clone coverage never closes an existing episode in the real health engine', () => {
  const f = episodeFixture(); f.setRoots([]);
  const next = runHealthTick(f.initial.state, { selfSync: f.selfSync, cloneLag: [] }, [f.descriptor], 2000);
  expect(f.inspect).toHaveBeenCalledTimes(1);
  expect(next.state.episodes[f.key]?.status).toBe('open');
  expect(next.transitions.some(t => t.type === 'closed')).toBe(false);
});
it('empty coverage cannot close an existing episode and explicit fresh evidence can', () => {
  const f = episodeFixture(); f.setRoots([]);
  const unknown = runHealthTick(f.initial.state, { selfSync: [], cloneLag: [] }, [f.descriptor], 2000);
  expect(unknown.state.episodes[f.key]?.status).toBe('open');
  f.setRoots([f.cloneRoot]); f.setMode('fresh');
  const fresh = runHealthTick(unknown.state, { selfSync: f.selfSync, cloneLag: [] }, [f.descriptor], 3000);
  expect(fresh.evaluations[0].results).toContainEqual(expect.objectContaining({ subject: `clone:${f.cloneRoot}:service:com.we.sampler`, breach: false }));
  expect(fresh.transitions).toContainEqual(expect.objectContaining({ type: 'closed', key: f.key }));
});

it.each([['unmapped root', []], ['unreadable inventory', null]])('coverage recovery clears only its own alert while preserving a stale service: %s', (_name, roots) => {
  const f = episodeFixture(); f.setRoots(roots);
  const unknown = runHealthTick(f.initial.state, { selfSync: f.selfSync, cloneLag: [] }, [f.descriptor], 2000);
  const coverage = Object.values(unknown.state.episodes).find(ep => ep.subject.startsWith('coverage:'));
  expect(coverage?.status).toBe('open');
  f.setRoots([f.cloneRoot]);
  const recovered = runHealthTick(unknown.state, { selfSync: f.selfSync, cloneLag: [] }, [f.descriptor], 3000);
  expect(recovered.state.episodes[f.key]?.status).toBe('open');
  expect(recovered.state.episodes[coverage.key]).toBeUndefined();
  expect(recovered.transitions).toContainEqual(expect.objectContaining({ type: 'closed', key: coverage.key }));
});

it.each(['thrown inspection', 'incomplete result', 'explicit unknown evidence'])('inspection failure recovers its synthetic episode without closing genuinely stale service alerts: %s', mode => {
  const f = episodeFixture();
  const failure = () => {
    if (mode === 'thrown inspection') throw new Error('temporary inspection failure');
    if (mode === 'incomplete result') return undefined;
    return [{ label: null, reason: 'inspection-failed' }];
  };
  const probes = { selfSync: f.selfSync, cloneLag: [] };
  const unknownKey = episodeKey(smell.id, `clone:${f.cloneRoot}:service:unknown`);
  f.inspect.mockImplementationOnce(failure);
  const failed = runHealthTick(f.initial.state, probes, [f.descriptor], 2000);
  expect(failed.state.episodes[unknownKey]?.status).toBe('open');
  expect(failed.state.episodes[f.key]?.status).toBe('open');
  f.inspect.mockImplementationOnce(failure);
  const stillUnknown = runHealthTick(failed.state, probes, [f.descriptor], 3000);
  expect(stillUnknown.state.episodes[unknownKey]?.status).toBe('open');
  expect(stillUnknown.transitions.some(t => t.type === 'closed')).toBe(false);
  const recovered = runHealthTick(stillUnknown.state, probes, [f.descriptor], 4000);
  expect(recovered.state.episodes[unknownKey]).toBeUndefined();
  expect(recovered.state.episodes[f.key]?.status).toBe('open');
  expect(recovered.transitions.filter(t => t.type === 'closed').map(t => t.key)).toEqual([unknownKey]);
  expect(recovered.evaluations[0].results).toContainEqual(expect.objectContaining({
    subject: `clone:${f.cloneRoot}:service:unknown`, breach: false,
  }));
});
