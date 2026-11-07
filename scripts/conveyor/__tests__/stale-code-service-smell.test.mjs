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
  const rows = smell.evaluate({ cloneLag: [{ cloneRoot }] }, { findStaleCodeServices: findStale, listCloneRoots: () => [cloneRoot], env: {} });
  expect(findStale).toHaveBeenCalledWith({ cloneRoot, selfLabel: null, onFreshService: expect.any(Function) }); expect(rows).toHaveLength(3);
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

it('the watching daemon passes its own launchd label so it is never flagged for its own pre-adoption start', () => {
  const cloneRoot = resolve('fixtures/clone');
  const findStale = vi.fn(() => []);
  smell.evaluate({ cloneLag: [{ cloneRoot }] }, { findStaleCodeServices: findStale, listCloneRoots: () => [cloneRoot], env: { XPC_SERVICE_NAME: 'com.we.adopter' } });
  expect(findStale).toHaveBeenCalledWith(expect.objectContaining({ cloneRoot, selfLabel: 'com.we.adopter' }));
});

// Subjects that are never re-emitted (removed/renamed plist, service no longer clone-backed, recovered
// agentsDir, retired clone) must still close, but only on positive evidence in the real health engine.
function stuckFixture(subjectOf, seeded = { label: 'com.we.gone', plistPath: 'gone.plist', reason: 'stale-code' }) {
  const f = episodeFixture();
  const staleKey = subjectOf(f.cloneRoot);
  let flags = [seeded];
  f.inspect.mockImplementation(() => flags);
  const probes = { selfSync: f.selfSync, cloneLag: [] };
  const opened = runHealthTick(emptyHealthState(), probes, [f.descriptor], 1000);
  const key = episodeKey(smell.id, staleKey);
  expect(opened.state.episodes[key]?.status).toBe('open');
  return { ...f, key, probes, opened, setFlags: v => { flags = v; } };
}
const serviceSubject = label => root => `clone:${root}:service:${label}`;
it('a stale service whose plist was removed (never re-emitted) closes after a complete inspection', () => {
  const f = stuckFixture(serviceSubject('com.we.gone'));
  f.setFlags([]);
  const next = runHealthTick(f.opened.state, f.probes, [f.descriptor], 2000);
  expect(next.state.episodes[f.key]).toBeUndefined();
  expect(next.transitions).toContainEqual(expect.objectContaining({ type: 'closed', key: f.key }));
});
it('a recovered unreadable agentsDir subject closes once the inspection completes', () => {
  const f = stuckFixture(root => `clone:${root}:service:/Users/x/LaunchAgents`, { label: null, plistPath: '/Users/x/LaunchAgents', reason: 'plist-unreadable' });
  f.setFlags([{ label: null, plistPath: '/Users/x/LaunchAgents', reason: 'plist-unreadable' }]);
  const stillBad = runHealthTick(f.opened.state, f.probes, [f.descriptor], 2000);
  expect(stillBad.state.episodes[f.key]?.status).toBe('open');
  f.setFlags([]);
  const recovered = runHealthTick(stillBad.state, f.probes, [f.descriptor], 3000);
  expect(recovered.state.episodes[f.key]).toBeUndefined();
});
it.each([['unreadable plist elsewhere', [{ label: null, plistPath: 'other.plist', reason: 'plist-unreadable' }]],
  ['thrown inspection', null]])('an absent subject stays open while the clone inspection is incomplete: %s', (_n, flags) => {
  const f = stuckFixture(serviceSubject('com.we.gone'));
  f.inspect.mockImplementation(() => { if (flags === null) throw new Error('cannot inspect'); return flags; });
  const next = runHealthTick(f.opened.state, f.probes, [f.descriptor], 2000);
  expect(next.state.episodes[f.key]?.status).toBe('open');
  expect(next.transitions.some(t => t.type === 'closed' && t.key === f.key)).toBe(false);
});
it('an episode of a clone that left a fully-known managed inventory closes; unknown inventory keeps it open', () => {
  const f = stuckFixture(serviceSubject('com.we.gone'));
  const other = resolve('fixtures/other-clone');
  f.setRoots([other]); f.setFlags([]);
  const probes = { selfSync: [{ cloneKey: cloneKey(other) }], cloneLag: [] };
  const retired = runHealthTick(f.opened.state, probes, [f.descriptor], 2000);
  expect(retired.state.episodes[f.key]).toBeUndefined();
  f.setRoots([]);
  const unknown = runHealthTick(f.opened.state, f.probes, [f.descriptor], 2000);
  expect(unknown.state.episodes[f.key]?.status).toBe('open');
});
it('non-clone state-directory rows (conveyor-state, plain dirs) with clean service evidence open zero coverage episodes', () => {
  const cloneRoot = resolve('fixtures/state-layout-clone');
  const inspect = ({ onFreshService }) => { onFreshService({ label: 'com.we.sampler', plistPath: 'sampler.plist' }); return []; };
  const descriptor = { ...smell, evaluate: (probes, ctx) => smell.evaluate(probes, { ...ctx, listCloneRoots: () => [cloneRoot], findStaleCodeServices: inspect }) };
  const selfSync = [{ cloneKey: cloneKey(cloneRoot), alerts: [], rebuild: null }, { cloneKey: 'conveyor-state', alerts: [], rebuild: null },
    { cloneKey: 'locks', alerts: [], rebuild: null }, { cloneKey: 'jobs', alerts: [], rebuild: null }];
  const tick = runHealthTick(emptyHealthState(), { selfSync, cloneLag: [{ cloneRoot }] }, [descriptor], 1000);
  expect(Object.values(tick.state.episodes).filter(ep => ep.subject.startsWith('coverage:'))).toEqual([]);
  expect(Object.keys(tick.state.episodes)).toEqual([]);
});
it('an already-open coverage:conveyor-state episode closes once that non-clone row is skipped', () => {
  const root = resolve('fixtures/closing-clone');
  const ctx = { findStaleCodeServices: () => [], listCloneRoots: () => [root], env: {},
    episodes: { e1: { smell: 'stale-code-service', subject: 'coverage:conveyor-state' }, e2: { smell: 'stale-code-service', subject: `coverage:${cloneKey(resolve('fixtures/gone'))}` } } };
  const rows = smell.evaluate({ selfSync: [{ cloneKey: 'conveyor-state' }], cloneLag: [{ cloneRoot: root }] }, ctx);
  expect(rows.find(row => row.subject === 'coverage:conveyor-state')).toMatchObject({ breach: false });
  // A hashed clone key is never closed by absence: it stays open until positive coverage evidence re-emits it.
  expect(rows.some(row => row.subject.startsWith(`coverage:${cloneKey(resolve('fixtures/gone'))}`))).toBe(false);
  // Unreadable self-sync evidence closes nothing.
  expect(smell.evaluate({ selfSync: null, cloneLag: [{ cloneRoot: root }] }, ctx).some(row => row.subject === 'coverage:conveyor-state')).toBe(false);
});
it('a real clone key (hashed) with no known root still yields unknown coverage', () => {
  const known = resolve('fixtures/known-clone'), stray = cloneKey(resolve('fixtures/unlisted-clone'));
  const rows = smell.evaluate({ selfSync: [{ cloneKey: cloneKey(known) }, { cloneKey: stray }, { cloneKey: 'conveyor-state' }], cloneLag: [{ cloneRoot: known }] },
    { findStaleCodeServices: () => [], listCloneRoots: () => [known], env: {} });
  expect(rows.find(row => row.subject === `coverage:${stray}`)?.breach).toBe(true);
  expect(rows.some(row => row.subject === 'coverage:conveyor-state')).toBe(false);
});
