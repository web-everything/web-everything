import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CLASSES, loadCapacitySettings, readCapacity, admit } from '../host-capacity.mjs';
import { hostLoadAdmission } from '../host-load.mjs';
import { defaultReviewHostAdmission } from '../../../skills-src/conveyor/review-daemon.mjs';
import { applyRedTeamQueueFloor, loadRedTeamQueueFloor, raiseReviewStartsPerTick } from '../red-team-dispatch-queue.mjs';

const native = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal(), execFileSync: native.exec }));
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

const mockSettingsFile = read => {
  const original = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) =>
    String(file).endsWith('/settings/host-capacity.json') ? read() : original(file, ...args));
  syncBuiltinESMExports();
};

const settings = loadCapacitySettings({ env: {} });
const now = () => Date.parse('2026-11-10T12:00:00Z');
const row = (idle, age = 0) => ({ sampledAt: new Date(now() - age * 1000).toISOString(), freshUntil: new Date(now() + 30000).toISOString(), cpu: { idlePct: idle } });
const evidence = (idle = 40, mem = 4096, extra = {}) => readCapacity({ settings, env: {}, now,
  history: () => [row(idle, 60), row(idle)], memory: () => mem, load: () => [79], cores: () => 12,
  sample: () => { throw Error('unexpected direct sample'); }, ...extra });
const decide = (cls, idle, mem) => admit(cls, { settings, read: () => evidence(idle, mem) });

describe('class capacity floors', () => {
  for (const cls of CLASSES) {
    it.each([-0.1, 0, 0.1])(`${cls} at threshold offset %s`, offset => {
      expect(decide(cls, settings.idlePct[cls] + offset).admit).toBe(offset >= 0);
    });
  }
  it('high load average is display only', () => {
    const decision = decide('review', 40);
    expect(decision.admit).toBe(true);
    expect(decision.reason).toContain('loadavg 79');
    expect(decision.reason).toContain('display only');
  });
  it.each(CLASSES)('%s enforces the hard memory floor', cls => {
    expect(decide(cls, 100, 2047).admit).toBe(false);
    expect(decide(cls, 100, 2048).admit).toBe(true);
  });
  it('unknown class holds without reading the host', () => {
    const read = vi.fn();
    expect(admit('typo', { settings, read }).admit).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([NaN, Infinity, null, undefined, '40', -1, 101])('invalid CPU %s holds', idlePct => {
    expect(admit('review', { settings, read: () => ({ idlePct, memFreeGB: 4 }) }).admit).toBe(false);
  });
  it.each([NaN, Infinity, null, -1, '4096'])('invalid memory %s holds', mem => {
    expect(decide('review', 40, mem).admit).toBe(false);
  });
  it('thrown memory read holds', () => {
    expect(admit('review', { settings, read: () => evidence(40, 4096, { memory: () => { throw Error('denied'); } }) }).admit).toBe(false);
  });
});

describe('window and source selection', () => {
  it('averages the window so a last-sample spike cannot admit', () => {
    const read = () => evidence(40, 4096, { history: () => [row(100, 100), row(0, 80), row(0, 40), row(25)] });
    expect(read().idlePct).toBeCloseTo(25 / 3);
    expect(admit('review', { settings, read }).admit).toBe(false);
  });
  it.each([[], [row(40)], [row(40, 100), row(40, 120)]].map(rows => ({ rows })))('missing/short/stale telemetry falls back to two uncached direct intervals: $rows', ({ rows }) => {
    const sample = vi.fn().mockReturnValueOnce({ ok: true, idlePct: 20 }).mockReturnValueOnce({ ok: true, idlePct: 40 });
    expect(evidence(40, 4096, { history: () => rows, sample })).toMatchObject({ idlePct: 30, source: 'direct' });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(sample).toHaveBeenCalledWith({ ttlMs: 0 });
  });
  it.each(['expired', 'missing', 'invalid'])('sampler %s freshUntil falls back and cannot admit on expired telemetry', state => {
    const rows = [row(100, 10), row(100)];
    for (const entry of rows) {
      if (state === 'missing') delete entry.freshUntil;
      else entry.freshUntil = state === 'expired' ? new Date(now() - 1).toISOString() : 'bad';
    }
    const sample = vi.fn(() => ({ ok: true, idlePct: 0 }));
    const read = () => evidence(100, 4096, { history: () => rows, sample });
    expect(admit('review', { settings, read })).toMatchObject({ admit: false, source: 'direct' });
    expect(sample).toHaveBeenCalledTimes(2);
  });
  it('excludes expired rows even when the latest row is fresh', () => {
    const expired = { ...row(100, 10), freshUntil: new Date(now() - 1).toISOString() };
    expect(evidence(40, 4096, { history: () => [expired, row(0, 5), row(0)] }))
      .toMatchObject({ idlePct: 0, source: 'resource-sampler' });
  });
  it('accepts freshUntil exactly now but keeps maxFreshSec as an upper bound', () => {
    const rows = [row(40, 20), row(40, 10)].map(entry => ({ ...entry, freshUntil: new Date(now()).toISOString() }));
    expect(evidence(40, 4096, { history: () => rows })).toMatchObject({ source: 'resource-sampler' });
    const sample = vi.fn(() => ({ ok: true, idlePct: 0 }));
    expect(evidence(40, 4096, { settings: { ...settings, maxFreshSec: 5 }, history: () => rows, sample }))
      .toMatchObject({ source: 'direct', idlePct: 0 });
    expect(sample).toHaveBeenCalledTimes(2);
    const expiredLatest = { ...row(100), freshUntil: new Date(now() - 1).toISOString() };
    expect(evidence(40, 4096, { settings: { ...settings, maxFreshSec: 5 },
      history: () => [...rows, expiredLatest], sample })).toMatchObject({ source: 'direct', idlePct: 0 });
  });
  it.each([() => [row(NaN)], () => [{ sampledAt: 'bad', cpu: { idlePct: 40 } }], () => null,
    () => { throw Error('corrupt history'); }])('misread sampler holds without direct fallback', history => {
    const sample = vi.fn();
    const read = () => evidence(40, 4096, { history, sample });
    expect(admit('review', { settings, read }).admit).toBe(false);
    expect(sample).not.toHaveBeenCalled();
  });
  it.each([{ ok: false, idlePct: 40 }, { ok: true, idlePct: NaN }, { ok: true, idlePct: 101 }])('misread direct sample holds', result => {
    expect(admit('review', { settings, read: () => evidence(40, 4096, { history: () => [], sample: () => result }) }).admit).toBe(false);
  });
  it('parses actual sampler history rows and holds malformed JSON/IO', () => {
    for (const readFile of [() => '{bad', () => { throw Error('denied'); }]) {
      const read = () => evidence(40, 4096, { history: undefined, root: '/fixture', readFile });
      expect(admit('review', { settings, read }).admit).toBe(false);
    }
    expect(evidence(40, 4096, { history: undefined, root: '/fixture', readFile: () => [row(20, 60), row(40)].map(JSON.stringify).join('\n') })).toMatchObject({ idlePct: 30, source: 'resource-sampler' });
  });
  it('unreadable display probes cannot veto valid capacity', () => {
    expect(evidence(40, 4096, { load: () => { throw Error('display unavailable'); } }).error).toBeUndefined();
  });
});

describe('settings', () => {
  it.each(['', ' ', 'bad', 'NaN', 'Infinity', '-1', '101', '0', '5'])('invalid/looser review override %j never loosens', value => {
    expect(loadCapacitySettings({ env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: value } }).idlePct.review).toBe(10);
  });
  it('file and environment can tighten', () => {
    const readFile = () => JSON.stringify({ hostCapacity: { idlePct: { review: 30 }, minMemoryMb: 1, windowSec: 120 } });
    expect(loadCapacitySettings({ readFile, env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: '20' } })).toMatchObject({ idlePct: { review: 30 }, minMemoryMb: 2048, windowSec: 120 });
    const log = vi.fn();
    expect(loadCapacitySettings({ env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: '35' }, log }).idlePct.review).toBe(35);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('env WE_HOST_CAPACITY_REVIEW_IDLE_PCT'));
  });
});

describe('settings evidence failures', () => {
  it.each(['{', 'null', '[]', '{}', '{"hostCapacity":null}', '{"hostCapacity":[]}',
    '{"hostCapacity":"bad"}', '{"hostCapacity":{"idlePct":[]}}'])('malformed settings %s hold before reading capacity', text => {
    const readFile = () => text;
    expect(() => loadCapacitySettings({ env: {}, readFile })).toThrow('settings unreadable');
    mockSettingsFile(readFile);
    const read = vi.fn(() => ({ idlePct: 100, memFreeGB: 8 }));
    expect(admit('review', { env: {}, read })).toMatchObject({ admit: false, reason: expect.stringContaining('settings unreadable') });
    expect(read).not.toHaveBeenCalled();
  });
  it('unreadable settings hold; missing settings use defaults', () => {
    const denied = () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); };
    expect(() => loadCapacitySettings({ env: {}, readFile: denied })).toThrow('settings unreadable');
    mockSettingsFile(denied);
    expect(admit('review', { env: {}, read: () => ({ idlePct: 100, memFreeGB: 8 }) }))
      .toMatchObject({ admit: false, reason: expect.stringContaining('settings unreadable') });
    const missing = () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); };
    expect(loadCapacitySettings({ env: {}, readFile: missing })).toMatchObject({ idlePct: { review: 10 }, minMemoryMb: 2048 });
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    mockSettingsFile(missing);
    expect(admit('review', { env: {}, read: () => ({ idlePct: 100, memFreeGB: 8 }) }).admit).toBe(true);
  });
  it('invalid individual settings preserve stricter floors', () => {
    const readFile = () => JSON.stringify({ hostCapacity: { minMemoryMb: 'bad', windowSec: -1,
      idlePct: { review: 'bad', build: 30 } } });
    expect(loadCapacitySettings({ env: { WE_HOST_CAPACITY_BUILD_IDLE_PCT: 'bad' }, readFile }))
      .toMatchObject({ minMemoryMb: 2048, windowSec: 90, idlePct: { review: 10, build: 30 } });
  });
});

describe('review wiring and red-team floor', () => {
  it.each([[40, true], [5, false]])('load 79/12, idle %s => review admitted %s', (idle, admitted) => {
    const log = vi.fn();
    const result = defaultReviewHostAdmission({ env: {}, log, capacityRead: () => evidence(idle),
      loadPolicy: () => ({ settings: { host: { maxReviewDispatchPerTick: 1, maxLoadPerCore: 0.1, minMemoryHeadroomMb: 2048 } } }) });
    expect(result.admitted).toBe(admitted);
    expect(result.maxPerTick).toBe(1);
    expect(result.reason).toContain('class=review');
    expect(result.reason).toContain('display only');
    if (admitted) expect(log).toHaveBeenCalledWith(expect.stringContaining('review-daemon: host-capacity admit class=review idle=40% mem=4GB source=resource-sampler'));
  });
  it('wired host-load retains policy memory floors and never legacy load/memory probes', () => {
    const forbidden = () => { throw Error('legacy probe invoked'); };
    expect(hostLoadAdmission({ capacityClass: 'smoke', capacityRead: () => evidence(40),
      load: forbidden, memory: forbidden, capacity: forbidden, interactive: true }).admitted).toBe(true);
    expect(hostLoadAdmission({ capacityClass: 'review', capacityRead: () => evidence(40, 100), interactive: true }).admitted).toBe(false);
  });
  it.each([[8192, 2048], [2048, 6144]])('class admission retains policy %sMB and capacity %sMB memory floors', (min, capacityMin) => {
    const result = hostLoadAdmission({ capacityClass: 'review', env: {},
      policy: { settings: { host: { minMemoryHeadroomMb: min } } },
      capacitySettings: { ...settings, minMemoryMb: capacityMin }, capacityRead: () => evidence(40, 4096) });
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain(`memory>=${Math.max(capacityMin, min)}MB`);
  });
  it.each(['2', '4'])('default capacity memory reader holds on macOS pressure %s', pressure => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    native.exec.mockReset().mockReturnValue(pressure);
    const read = () => evidence(40, 4096, { memory: undefined });
    expect(read().memFreeGB).toBe(0);
    expect(admit('review', { settings, read }).admit).toBe(false);
    expect(native.exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], expect.any(Object));
  });
  it('default capacity memory reader holds on unreadable memory evidence', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    native.exec.mockReset().mockImplementation(() => { throw Error('unreadable memory'); });
    const read = () => evidence(40, 4096, { memory: undefined });
    expect(admit('review', { settings, read }).admit).toBe(false);
  });
  it('red-team floor and review starts use the shared stricter threshold and windowed idle', () => {
    const capacitySettings = loadCapacitySettings({ env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: '30' } });
    const floor = loadRedTeamQueueFloor({ capacitySettings, env: {}, readFile: () => JSON.stringify({ redTeam: { queue: { minConcurrent: 2, minConcurrentIdlePct: 0, reviewStartsPerTickWhileIdle: 3 } } }) });
    expect(floor.idlePct).toBe(30);
    const capacity = { remainingStarts: 1, startsCeiling: 3 };
    const cpuIdlePct = evidence(40, 4096, { history: () => [row(0, 60), row(40)] }).idlePct;
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct });
    expect(capacity.remainingStarts).toBe(1);
    expect(raiseReviewStartsPerTick(2, { floor, cpuIdlePct })).toBe(2);
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct: 30 });
    expect(capacity.remainingStarts).toBe(2);
    expect(raiseReviewStartsPerTick(2, { floor, cpuIdlePct: 30 })).toBe(3);
  });
});
