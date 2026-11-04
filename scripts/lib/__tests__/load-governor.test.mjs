import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GOVERNOR_DEFAULTS as D, resolveGovernorSettings, governorState, shouldHold, releaseOrder, ownerClass,
  setPause, readPause, listPauses, governorTick } from '../load-governor.mjs';
import smell from '../../conveyor/health-smells/load-over-target.mjs';
import { main } from '../../operations/worker-pause.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'lg-'));
describe('settings', () => {
  it('defaults, overrides, invalid ignored, band cannot invert', () => {
    expect(resolveGovernorSettings().targetLoadPerCore).toBe(2);
    const s = resolveGovernorSettings({ settings: { loadGovernor: { targetLoadPerCore: 1.5, resumeBelowPerCore: 9, holdFromClass: 'nope' } } });
    expect(s.targetLoadPerCore).toBe(1.5); expect(s.resumeBelowPerCore).toBeCloseTo(1.2); expect(s.holdFromClass).toBe('daemon-fix');
    expect(resolveGovernorSettings({ env: { WE_LOAD_GOVERNOR_TARGET: 'x' } }).targetLoadPerCore).toBe(2);
  });
});
describe('settings: a priority override can never leave nothing holdable', () => {
  const holdsSomething = (s) => ['feature-build', 'metrics-report', 'daemon-fix-x'].some((text) => shouldHold({ text, holding: true, settings: s }).hold);
  it.each([
    ['omits the default cutoff', { priority: ['main-fix', 'delivery-unblock', 'build', 'report'] }],
    ['only exempt classes', { priority: ['main-fix', 'delivery-unblock'] }],
    ['cutoff names a class missing from the override', { priority: ['main-fix', 'build'], holdFromClass: 'daemon-fix' }],
    ['cutoff is the last exempt class only', { priority: ['build', 'main-fix'], holdFromClass: 'main-fix' }],
  ])('falls back to a working cutoff when the override %s', (_n, loadGovernor) => {
    const s = resolveGovernorSettings({ settings: { loadGovernor } });
    expect(s.priority.includes(s.holdFromClass)).toBe(true);
    expect(holdsSomething(s)).toBe(true);
    expect(governorState({ loadPerCore: 3, settings: s }).holding).toBe(true);
  });
  it.each([
    ['holdable class no owner can classify as', { priority: ['main-fix', 'delivery-unblock', 'build', 'foo'], holdFromClass: 'foo' }],
    ['empty-string pattern on an exempt class', { classPatterns: { 'main-fix': [''] } }],
    ['blank pattern everywhere it matters', { classPatterns: { 'main-fix': ['  '], 'daemon-fix': [''] } }],
  ])('never leaves the governor a no-op: %s', (_n, loadGovernor) => {
    const s = resolveGovernorSettings({ settings: { loadGovernor } });
    expect(holdsSomething(s)).toBe(true);
  });
  it('exempt classes stay exempt even when the priority omits them', () => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['daemon-fix', 'build'] } } });
    for (const text of ['red-main repair', 'unblock land']) expect(shouldHold({ text, holding: true, settings: s }).hold).toBe(false);
    expect(shouldHold({ text: 'feature-build', holding: true, settings: s }).hold).toBe(true);
  });
  it('resume == target collapses the band, so it is pulled below target; tiny maxPauseMinutes is ignored', () => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { targetLoadPerCore: 2, resumeBelowPerCore: 2, maxPauseMinutes: 0.0001 } } });
    expect(s.resumeBelowPerCore).toBeLessThan(s.targetLoadPerCore);
    expect(s.maxPauseMinutes).toBe(D.maxPauseMinutes);
  });
  it('governorTick under a bad override still pauses a real holdable owner', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json');
    const settings = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['main-fix', 'delivery-unblock', 'build', 'report'] } } });
    const r = governorTick({ loadPerCore: 3, owners: [{ owner: 'feature-build-1' }, { owner: 'red-main-fix' }], settings, stateFile, dir, now: new Date('2026-11-03T13:00:00Z') });
    expect(r.events.filter((e) => e.event === 'paused').map((e) => e.owner)).toEqual(['feature-build-1']);
  });
  it('keeps a complete, valid override', () => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['main-fix', 'delivery-unblock', 'build', 'report'], holdFromClass: 'report' } } });
    expect(s.priority).toEqual(['main-fix', 'delivery-unblock', 'build', 'report']); expect(s.holdFromClass).toBe('report');
    expect(shouldHold({ text: 'metrics-report', holding: true, settings: s }).hold).toBe(true);
  });
});
describe('hysteresis', () => {
  it('holds above target, keeps holding until below resume, then opens', () => {
    expect(governorState({ loadPerCore: 2.1 }).holding).toBe(true);
    expect(governorState({ loadPerCore: 1.8, holding: true }).holding).toBe(true);
    expect(governorState({ loadPerCore: 1.8, holding: false }).holding).toBe(false);
    expect(governorState({ loadPerCore: 1.59, holding: true }).holding).toBe(false);
  });
  it('unreadable load fails open and says so', () => {
    const r = governorState({ loadPerCore: NaN, holding: true });
    expect(r).toMatchObject({ holding: false, unreadable: true });
  });
});
describe('hold and release', () => {
  it('exempts main-fix and delivery-unblock, holds the rest', () => {
    const h = (text) => shouldHold({ text, holding: true }).hold;
    expect(h('red-main-repair')).toBe(false); expect(h('drain-unblock')).toBe(false);
    expect(h('daemon-fix-x')).toBe(true); expect(h('feature-build')).toBe(true); expect(h('bottleneck-report')).toBe(true);
    expect(shouldHold({ text: 'build', holding: false }).hold).toBe(false);
    expect(shouldHold({ text: 'build', holding: true }).reason).toBe('load-governor');
  });
  it('releases in priority order, then arrival', () => {
    const w = [{ owner: 'r-report', at: '2026-01-01T00:00:01Z' }, { owner: 'b2', at: '2026-01-01T00:00:03Z' }, { owner: 'daemon-1', at: '2026-01-01T00:00:09Z' }, { owner: 'b1', at: '2026-01-01T00:00:02Z' }];
    expect(releaseOrder(w).map((x) => x.owner)).toEqual(['daemon-1', 'b1', 'b2', 'r-report']);
    expect(ownerClass('anything')).toBe('build');
  });
});
describe('settings: class names that collide with Object members', () => {
  it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])('priority naming %s never throws in ownerClass/shouldHold', (name) => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['daemon-fix', name] } } });
    expect(() => ownerClass('feature-build', s)).not.toThrow();
    expect(() => shouldHold({ text: 'feature-build', holding: true, settings: s })).not.toThrow();
    expect(() => releaseOrder([{ text: 'x' }], s)).not.toThrow();
  });
  it('a __proto__ classPatterns key does not swap the prototype', () => {
    const s = resolveGovernorSettings({ settings: JSON.parse('{"loadGovernor":{"classPatterns":{"__proto__":["x"]}}}') });
    expect(Object.getPrototypeOf(s.classPatterns)).toBe(Object.prototype);
  });
});
describe('settings: a priority override without a cutoff resolves one inside that list', () => {
  it('keeps the override and picks the first reachable non-exempt class as cutoff', () => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['main-fix', 'delivery-unblock', 'build', 'report'] } } });
    expect(s.priority).toEqual(['main-fix', 'delivery-unblock', 'build', 'report']);
    expect(s.holdFromClass).toBe('build');
    expect(shouldHold({ text: 'feature-build', holding: true, settings: s }).hold).toBe(true);
    expect(shouldHold({ text: 'red-main repair', holding: true, settings: s }).hold).toBe(false);
  });
  it('keeps the default cutoff when the override still contains it', () => {
    const s = resolveGovernorSettings({ settings: { loadGovernor: { priority: ['build', 'daemon-fix', 'report'] } } });
    expect(s.holdFromClass).toBe('daemon-fix'); expect(s.priority.includes(s.holdFromClass)).toBe(true);
  });
});
describe('pause flags', () => {
  const now = new Date('2026-11-03T13:00:00Z');
  it('a worker reclassified as exempt loses its governor pause, but never an operator pause', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json');
    let r = governorTick({ loadPerCore: 3, owners: [{ owner: 'w1', text: 'feature-build' }, { owner: 'w2', text: 'feature-build' }], stateFile, dir, now });
    expect(r.events.filter((e) => e.event === 'paused').length).toBe(2);
    setPause({ dir, owner: 'w2', reason: 'by hand', by: 'operator', now });
    expect(readPause({ dir, owner: 'w1', now })).not.toBeNull();
    r = governorTick({ loadPerCore: 3, owners: [{ owner: 'w1', text: 'red-main-repair' }, { owner: 'w2', text: 'red-main-repair' }], stateFile, dir, now });
    expect(readPause({ dir, owner: 'w1', now })).toBeNull();
    expect(readPause({ dir, owner: 'w2', now })).toMatchObject({ by: 'operator' });
    expect(r.events.filter((e) => e.event === 'resumed').map((e) => e.owner)).toEqual(['w1']);
  });
  it('set, read, expire by TTL', () => {
    const dir = tmp();
    setPause({ dir, owner: 'w1', reason: 'r', now });
    expect(readPause({ dir, owner: 'w1', now: new Date(now.getTime() + 60_000) })).toMatchObject({ reason: 'r' });
    expect(readPause({ dir, owner: 'w1', now: new Date(now.getTime() + 91 * 60_000) })).toBeNull();
    expect(listPauses({ dir, now: new Date(now.getTime() + 91 * 60_000) })).toEqual([]);
  });
  it('tick pauses holdable owners above target, resumes below, leaves exempt and operator flags', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json'); const log = [];
    const owners = [{ owner: 'build-a' }, { owner: 'red-main-fix' }, { owner: 'ops-hand' }];
    setPause({ dir, owner: 'ops-hand', reason: 'by hand', by: 'operator', now });
    let r = governorTick({ loadPerCore: 3, owners, stateFile, dir, now, log: (e) => log.push(e) });
    expect(r.events.map((e) => `${e.event}:${e.owner}`).sort()).toEqual(['paused:build-a']);
    expect(readPause({ dir, owner: 'red-main-fix', now })).toBeNull();
    r = governorTick({ loadPerCore: 1.8, owners, stateFile, dir, now }); // inside band: stays paused
    expect(readPause({ dir, owner: 'build-a', now })).not.toBeNull();
    r = governorTick({ loadPerCore: 1.0, owners, stateFile, dir, now, log: (e) => log.push(e) });
    expect(r.events.map((e) => e.event)).toContain('resumed');
    expect(readPause({ dir, owner: 'build-a', now })).toBeNull();
    expect(readPause({ dir, owner: 'ops-hand', now })).not.toBeNull();
    expect(log.map((e) => e.event)).toEqual(['paused', 'resumed']);
  });
  it('TTL is a hard cap: expired flag is not recreated while load stays high; main-fix never holdable', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json'); const o = [{ owner: 'build-a' }];
    governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now });
    const later = new Date(now.getTime() + 91 * 60_000);
    governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now: later });
    expect(readPause({ dir, owner: 'build-a', now: later })).toBeNull();
    expect(shouldHold({ text: 'main-fix', holding: true, settings: resolveGovernorSettings({ settings: { loadGovernor: { holdFromClass: 'main-fix' } } }) }).hold).toBe(false);
    expect(resolveGovernorSettings({ settings: { loadGovernor: { targetLoadPerCore: 1 } } }).resumeBelowPerCore).toBe(0.8);
  });
  it('TTL hard cap holds for owners whose name is sanitized on disk (build:42 -> build_42), across ticks and two owners sharing a filename', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json');
    const o = [{ owner: 'build:42' }, { owner: 'build/42' }, { owner: 'plain' }];
    governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now });
    expect(readPause({ dir, owner: 'build:42', now })).not.toBeNull();
    const later = new Date(now.getTime() + 91 * 60_000);
    const r = governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now: later });
    expect(r.events.filter((e) => e.event === 'paused')).toEqual([]);
    expect(readPause({ dir, owner: 'build:42', now: later })).toBeNull();
    const later2 = new Date(later.getTime() + 5 * 60_000); // next tick: still cooled, still not renewed
    expect(governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now: later2 }).events.filter((e) => e.event === 'paused')).toEqual([]);
    governorTick({ loadPerCore: 1.0, owners: o, stateFile, dir, now: later2 }); // load clears -> cooldown resets
    const r3 = governorTick({ loadPerCore: 3, owners: o, stateFile, dir, now: later2 });
    expect(r3.events.filter((e) => e.event === 'paused').map((e) => e.owner).sort()).toEqual(['build:42', 'plain']); // build/42 shares build_42's file, so it sees the fresh flag
  });
  it('unreadable load fails open: clears governor flags, sets none', () => {
    const dir = tmp(); const stateFile = join(tmp(), 'st.json');
    governorTick({ loadPerCore: 3, owners: [{ owner: 'build-a' }], stateFile, dir, now });
    const r = governorTick({ loadPerCore: NaN, owners: [{ owner: 'build-a' }], stateFile, dir, now });
    expect(r.events.map((e) => e.event)).toEqual(['load-unreadable', 'resumed']);
    expect(readPause({ dir, owner: 'build-a', now })).toBeNull();
  });
});
describe('worker-pause CLI and smell', () => {
  it.each([['--owner'], ['--owner='], ['--owner=  ']])('--resume %s with no usable value is an argument error and keeps every flag', (flag) => {
    const dir = tmp(); const out = []; const o = (s) => out.push(s); const now = new Date('2026-11-03T13:00:00Z');
    setPause({ dir, owner: 'a', reason: 'x', by: 'operator', now }); setPause({ dir, owner: 'b', reason: 'y', by: 'operator', now });
    expect(main(['--resume', flag], { dir, out: o, now })).not.toBe(0);
    expect(out.at(-1)).toMatch(/error/);
    expect(listPauses({ dir, now }).map((x) => x.owner).sort()).toEqual(['a', 'b']);
  });
  it('bare --resume still clears every flag', () => {
    const dir = tmp(); const now = new Date('2026-11-03T13:00:00Z');
    setPause({ dir, owner: 'a', reason: 'x', now }); setPause({ dir, owner: 'b', reason: 'y', now });
    expect(main(['--resume'], { dir, out: () => {}, now })).toBe(0);
    expect(listPauses({ dir, now })).toEqual([]);
  });
  it('sets, lists, resumes', () => {
    const dir = tmp(); const out = []; const o = (s) => out.push(s);
    expect(main(['--owner=w9', '--reason=x'], { dir, out: o })).toBe(0);
    expect(main(['--list'], { dir, out: o })).toBe(0); expect(out.at(-1)).toContain('w9');
    expect(main(['--resume', '--owner=w9'], { dir, out: o })).toBe(0); expect(out.at(-1)).toBe('resumed w9');
    expect(main([], { dir, out: o })).toBe(2);
  });
  it('smell breaches over target, counts paused, flags unreadable', () => {
    const s = Object.create(smell, { listPaused: { value: () => 3 }, target: { value: () => 2 } });
    const [a] = s.evaluate({ machineLoad: { load1: 60, cpuCount: 12 } });
    expect(a.breach).toBe(true); expect(a.summary).toContain('paused owners: 3');
    expect(s.evaluate({ machineLoad: { load1: 12, cpuCount: 12 } })[0].breach).toBe(false);
    expect(s.evaluate({ machineLoad: { load1: NaN, cpuCount: 12 } })[0].summary).toContain('unreadable');
  });
});
