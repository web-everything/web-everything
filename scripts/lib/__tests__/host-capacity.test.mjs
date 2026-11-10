import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CLASSES, loadCapacitySettings, readCapacity, admit } from '../host-capacity.mjs';
import { hostLoadAdmission } from '../host-load.mjs';
import { defaultReviewHostAdmission } from '../../../skills-src/conveyor/review-daemon.mjs';
import { applyRedTeamQueueFloor, loadRedTeamQueueFloor, raiseReviewStartsPerTick } from '../red-team-dispatch-queue.mjs';

afterEach(() => {
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
  history: () => [row(idle, 60), row(idle, 30), row(idle)], memory: () => mem, load: () => [79], cores: () => 12,
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
  it.each([
    ['two samples one second apart', [row(100, 1), row(0)]],
    ['two samples spanning half the window', [row(100, 45), row(0)]],
    ['three samples just below half the window', [row(100, 44.999), row(100, 20), row(100)]],
    ['duplicate timestamps', [row(100, 60), row(100, 60), row(100)]],
    ['decreasing timestamps', [row(100, 60), row(100, 10), row(100, 30), row(100)]],
  ])('%s holds until readable evidence on the next tick', (_name, rows) => {
    const read = () => evidence(40, 4096, { history: () => rows });
    expect(read()).toMatchObject({ error: expect.any(String), idlePct: null });
    expect(admit('review', { settings, read })).toMatchObject({ admit: false,
      reason: expect.stringContaining('hold until readable evidence on next tick') });
  });
  it.each([[90, [45, 20, 0]], [90, [60, 40, 20, 0]], [120, [60, 30, 0]]])(
    'admits an above-threshold average spanning at least half the %ss window', (windowSec, ages) => {
      const read = () => evidence(40, 4096, { settings: { ...settings, windowSec },
        history: () => ages.map((age, index) => row(index === 0 ? 100 : 0, age)) });
      expect(read()).toMatchObject({ idlePct: 100 / ages.length, source: 'resource-sampler' });
      expect(admit('review', { settings, read }).admit).toBe(true);
    });
  it('holds when the span is below half a configured window', () => {
    const read = () => evidence(40, 4096, { settings: { ...settings, windowSec: 120 },
      history: () => [row(100, 59.999), row(100, 30), row(100)] });
    expect(read().error).toEqual(expect.any(String));
    expect(admit('review', { settings, read }).admit).toBe(false);
  });
  it('averages the window so a last-sample spike cannot admit', () => {
    const read = () => evidence(40, 4096, { history: () => [row(100, 100), row(0, 80), row(0, 40), row(25)] });
    expect(read().idlePct).toBeCloseTo(25 / 3);
    expect(admit('review', { settings, read }).admit).toBe(false);
  });
  it.each([
    ['missing', []], ['short', [row(40)]], ['outside window', [row(40, 100), row(40, 120)]],
  ])('%s telemetry holds without sampling the host', (_name, rows) => {
    const sample = vi.fn(() => ({ ok: true, idlePct: 100 }));
    const read = () => evidence(40, 4096, { history: () => rows, sample });
    expect(read()).toMatchObject({ error: expect.any(String), idlePct: null });
    expect(admit('review', { settings, read })).toMatchObject({ admit: false,
      reason: expect.stringContaining('hold until readable evidence on next tick') });
    expect(sample).not.toHaveBeenCalled();
  });
  it.each(['expired', 'missing', 'invalid'])('newest sampler %s freshUntil holds without direct sampling', state => {
    const rows = [row(100, 60), row(100, 30), row(100)];
    if (state === 'missing') delete rows[2].freshUntil;
    else rows[2].freshUntil = state === 'expired' ? new Date(now() - 1).toISOString() : 'bad';
    const sample = vi.fn(() => ({ ok: true, idlePct: 100 }));
    const read = () => evidence(100, 4096, { history: () => rows, sample });
    expect(read().error).toEqual(expect.any(String));
    expect(admit('review', { settings, read }).admit).toBe(false);
    expect(sample).not.toHaveBeenCalled();
  });
  it('holds review on the full window despite expired busy rows and fresh idle rows', () => {
    const reviewSettings = { ...settings, idlePct: { ...settings.idlePct, review: 40 } };
    const rows = [80, 60, 40, 20].map(age => ({
      ...row(5, age), freshUntil: new Date(now() - 1).toISOString(),
    }));
    rows.push(row(90, 5), row(90));
    const read = () => evidence(40, 4096, { settings: reviewSettings, history: () => rows });
    expect(read()).toMatchObject({ idlePct: 200 / 6, source: 'resource-sampler' });
    expect(admit('review', { settings: reviewSettings, read }).admit).toBe(false);
  });
  it('accepts freshUntil exactly now but keeps maxFreshSec as an upper bound', () => {
    const rows = [row(40, 60), row(40, 30), row(40, 10)].map(entry => ({ ...entry, freshUntil: new Date(now()).toISOString() }));
    expect(evidence(40, 4096, { history: () => rows })).toMatchObject({ source: 'resource-sampler' });
    const sample = vi.fn(() => ({ ok: true, idlePct: 0 }));
    expect(evidence(40, 4096, { settings: { ...settings, maxFreshSec: 5 }, history: () => rows, sample }))
      .toMatchObject({ error: expect.any(String), idlePct: null });
    expect(sample).not.toHaveBeenCalled();
    const expiredLatest = { ...row(100), freshUntil: new Date(now() - 1).toISOString() };
    expect(evidence(40, 4096, { settings: { ...settings, maxFreshSec: 5 },
      history: () => [...rows, expiredLatest], sample })).toMatchObject({ error: expect.any(String), idlePct: null });
  });
  it.each([() => [row(NaN)], () => [{ sampledAt: 'bad', cpu: { idlePct: 40 } }], () => null,
    () => { throw Error('corrupt history'); }])('misread sampler holds without direct fallback', history => {
    const sample = vi.fn();
    const read = () => evidence(40, 4096, { history, sample });
    expect(admit('review', { settings, read }).admit).toBe(false);
    expect(sample).not.toHaveBeenCalled();
  });
  it('parses actual sampler history rows and holds malformed JSON/IO', () => {
    for (const readFile of [() => '', () => '{bad', () => { throw Error('denied'); },
      () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); }]) {
      const read = () => evidence(40, 4096, { history: undefined, root: '/fixture', readFile });
      expect(admit('review', { settings, read }).admit).toBe(false);
    }
    expect(evidence(40, 4096, { history: undefined, root: '/fixture', readFile: () => [row(20, 60), row(30, 30), row(40)].map(JSON.stringify).join('\n') })).toMatchObject({ idlePct: 30, source: 'resource-sampler' });
  });
  it('ignores invalid rows older than the window and decides from in-window rows', () => {
    const old = (age, extra) => ({ ...row(50, age), ...extra });
    const rows = [old(9000, { cpu: { idlePct: null } }), old(7000, { cpu: {} }), row(40, 60), row(40, 30), row(40)];
    expect(evidence(40, 4096, { history: () => rows })).toMatchObject({ idlePct: 40, source: 'resource-sampler' });
    expect(admit('review', { settings, read: () => evidence(40, 4096, { history: () => rows }) }).admit).toBe(true);
  });
  it('reads a real file with an old null-idle line and admits from the window', () => {
    const lines = [JSON.stringify({ ...row(0, 9000), cpu: { idlePct: null } }), ...[row(40, 60), row(40, 30), row(40)].map(r => JSON.stringify(r))].join('\n');
    expect(evidence(40, 4096, { history: undefined, root: '/fixture', readFile: () => lines })).toMatchObject({ idlePct: 40, source: 'resource-sampler' });
  });
  it('an unplaceable row anywhere holds', () => {
    for (const at of [0, 1, 4]) {
      const rows = [row(40, 9000), row(40, 60), row(40, 30), row(40)]; rows.splice(at, 0, { sampledAt: 'garbage', cpu: { idlePct: 40 } });
      expect(evidence(40, 4096, { history: () => rows })).toMatchObject({ error: 'invalid sampler reading', idlePct: null });
    }
    const lines = [row(40, 9000), row(40, 60), row(40, 30), row(40)].map(r => JSON.stringify(r)); lines.splice(1, 0, '{bad');
    expect(admit('review', { settings, read: () => evidence(40, 4096, { history: undefined, root: '/fixture', readFile: () => lines.join('\n') }) }).admit).toBe(false);
  });
  it.each([
    ['null idle', { cpu: { idlePct: null } }], ['out-of-range idle', { cpu: { idlePct: 101 } }],
    ['future sample', { sampledAt: new Date(now() + 5000).toISOString() }],
  ])('an invalid in-window row (%s) still holds', (_n, bad) => {
    const rows = [row(40, 60), { ...row(40, 30), ...bad }, row(40)];
    const read = () => evidence(40, 4096, { history: () => rows });
    expect(read()).toMatchObject({ error: expect.any(String), idlePct: null });
    expect(admit('review', { settings, read }).admit).toBe(false);
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
    const read = vi.fn(() => ({ idlePct: 100, memFreeGB: 8 }));
    expect(admit('review', { env: {}, read, readFile })).toMatchObject({ admit: false, reason: expect.stringContaining('settings unreadable') });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['EACCES', 'ENOENT'])('%s settings hold before reading capacity', code => {
    const readFile = () => { throw Object.assign(Error('unreadable'), { code }); };
    const read = vi.fn(() => ({ idlePct: 100, memFreeGB: 8 }));
    expect(() => loadCapacitySettings({ env: {}, readFile })).toThrow('settings unreadable');
    expect(admit('review', { env: {}, readFile, read })).toMatchObject({ admit: false,
      reason: expect.stringContaining('settings unreadable') });
    expect(read).not.toHaveBeenCalled();
  });
  it('invalid individual settings hold despite stricter floors', () => {
    const readFile = () => JSON.stringify({ hostCapacity: { minMemoryMb: 'bad', windowSec: -1,
      idlePct: { review: 'bad', build: 30 } } });
    expect(() => loadCapacitySettings({ env: { WE_HOST_CAPACITY_BUILD_IDLE_PCT: 'bad' }, readFile }))
      .toThrow('host-capacity settings unreadable');
    expect(admit('review', { env: {}, readFile, read: () => ({ idlePct: 100, memFreeGB: 8 }) }).admit).toBe(false);
  });
  it.each(['windowSec', 'maxFreshSec', 'minMemoryMb'].flatMap(key =>
    [0, -1, null, '90', true, [], {}, 1e309].map(value => ({ key, value }))))('invalid $key=$value holds before reading capacity', ({ key, value }) => {
    const readFile = () => `{"hostCapacity":{${JSON.stringify(key)}:${value === Infinity ? '1e309' : JSON.stringify(value)}}}`;
    expect(() => loadCapacitySettings({ env: {}, readFile })).toThrow('host-capacity settings unreadable');
    const read = vi.fn();
    expect(admit('review', { env: {}, readFile, read })).toMatchObject({ admit: false,
      reason: expect.stringContaining('host-capacity settings unreadable') });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(CLASSES.flatMap(cls => [-1, 101, null, '30', true, [], {}, 1e309].map(value => ({ cls, value }))))('invalid idlePct.$cls=$value holds', ({ cls, value }) => {
    const readFile = () => `{"hostCapacity":{"idlePct":{${JSON.stringify(cls)}:${value === Infinity ? '1e309' : JSON.stringify(value)}}}}`;
    expect(() => loadCapacitySettings({ env: {}, readFile })).toThrow('host-capacity settings unreadable');
    expect(admit('review', { env: {}, readFile, read: () => ({ idlePct: 100, memFreeGB: 8 }) }).admit).toBe(false);
  });
  it('absent keys use defaults and unknown idle classes are ignored', () => {
    const readFile = () => JSON.stringify({ hostCapacity: { idlePct: { typo: 'bad' } } });
    expect(loadCapacitySettings({ env: {}, readFile })).toMatchObject({ windowSec: 90, maxFreshSec: 90,
      minMemoryMb: 2048, idlePct: { blocker: 5, review: 10, smoke: 15, build: 15, background: 25 } });
  });
  it.each([0, 100])('valid idle boundary %s and invalid env preserve the configured floor', value => {
    const readFile = () => JSON.stringify({ hostCapacity: { idlePct: { review: value } } });
    expect(loadCapacitySettings({ env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: 'bad' }, readFile }).idlePct.review)
      .toBe(Math.max(10, value));
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
    const exec = vi.fn(() => pressure);
    const read = () => evidence(40, 4096, { memory: undefined, platform: 'darwin', exec });
    expect(read().memFreeGB).toBe(0);
    expect(admit('review', { settings, read }).admit).toBe(false);
    expect(exec).toHaveBeenCalledWith('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], expect.any(Object));
  });
  const vm = 'Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 2000000.\nPages speculative: 0.\nPages purgeable: 0.\nPages inactive: 0.';
  it.each(['', 'bad', '0', '3', '8', null, 'denied'])('unreadable/unknown pressure %s holds despite ample headroom', pressure => {
    const exec = vi.fn((command, args) => {
      if (args.includes('kern.memorystatus_vm_pressure_level')) {
        if (pressure === 'denied') throw Object.assign(Error('denied'), { code: 'EACCES' });
        return pressure;
      }
      return command === 'vm_stat' ? vm : 'free = 8192M';
    });
    const read = () => evidence(40, 4096, { memory: undefined, platform: 'darwin', exec });
    expect(read().error).toEqual(expect.stringContaining('memory pressure'));
    expect(admit('review', { settings, read })).toMatchObject({ admit: false,
      reason: expect.stringContaining('hold until readable evidence on next tick') });
    expect(exec.mock.calls.every(([command, args]) => command === 'sysctl' && args.includes('kern.memorystatus_vm_pressure_level'))).toBe(true);
  });
  it('normal macOS pressure admits with measured headroom and probes pressure once', () => {
    const exec = vi.fn((command, args) => args.includes('kern.memorystatus_vm_pressure_level')
      ? '1' : command === 'vm_stat' ? vm : 'free = 8192M');
    const read = () => evidence(40, 4096, { memory: undefined, platform: 'darwin', exec });
    expect(admit('review', { settings, read }).admit).toBe(true);
    expect(exec.mock.calls.filter(([, args]) => args.includes('kern.memorystatus_vm_pressure_level'))).toHaveLength(1);
  });
  it('non-macOS memory does not require the pressure sysctl', () => {
    const exec = vi.fn(() => { throw Error('unexpected exec'); });
    expect(evidence(40, 4096, { memory: undefined, platform: 'linux', exec }).error).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });
  it('red-team floor and review starts use the shared stricter threshold and windowed idle', () => {
    const capacitySettings = loadCapacitySettings({ env: { WE_HOST_CAPACITY_REVIEW_IDLE_PCT: '30' } });
    const floor = loadRedTeamQueueFloor({ capacitySettings, env: {}, readFile: () => JSON.stringify({ redTeam: { queue: { minConcurrent: 2, minConcurrentIdlePct: 0, reviewStartsPerTickWhileIdle: 3 } } }) });
    expect(floor.idlePct).toBe(30);
    const capacity = { remainingStarts: 1, startsCeiling: 3 };
    const cpuIdlePct = evidence(40, 4096, { history: () => [row(0, 60), row(20, 30), row(40)] }).idlePct;
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct });
    expect(capacity.remainingStarts).toBe(1);
    expect(raiseReviewStartsPerTick(2, { floor, cpuIdlePct })).toBe(2);
    applyRedTeamQueueFloor(capacity, { floor, cpuIdlePct: 30 });
    expect(capacity.remainingStarts).toBe(2);
    expect(raiseReviewStartsPerTick(2, { floor, cpuIdlePct: 30 })).toBe(3);
  });
});
