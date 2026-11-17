import { describe, it, expect, vi } from 'vitest';
import { buildSlotReport, parseSlotPsRows, slotChildren, probeSlotAlive, readSlotStatuses,
  resolveSlotThreshold, emitStuckSlots, formatSlotReport, DEFAULT_STUCK_AFTER_MS, MAX_AGE_MS } from '../red-team-slots.mjs';
import { pidAlive } from '../../lib/pid-alive.mjs';

const now = Date.parse('2026-11-11T12:00:00Z');
const status = (overrides = {}, idleMs = 1000) => ({
  data: { repo: 'org/repo', pr: 42, head: 'abcdef1234567', status: 'running', pid: 100, ...overrides },
  mtimeMs: now - idleMs, birthtimeMs: now - 5000,
});
const report = (options = {}) => buildSlotReport({ statuses: [status()], now, aliveFn: () => true, ...options });

describe('occupied red-team slot inventory', () => {
  it('attributes codex descendants to their parent PR through the ppid tree', () => {
    const psRows = parseSlotPsRows('100 1 01:00 node review-job\n101 100 00:50 red-team-codex\n102 101 00:45 codex exec\n103 1 00:30 unrelated');
    const result = report({ psRows });
    expect(result.slots[0]).toMatchObject({ pr: 42, kind: 'red-team', seat: null,
      children: [{ pid: 101, etime: '00:50', command: 'red-team-codex' }, { pid: 102, etime: '00:45', command: 'codex exec' }] });
  });

  it('marks a dead pid STUCK pid-dead even if the status is fresh', () => {
    expect(report({ aliveFn: () => false }).stuck[0].reason).toBe('pid-dead');
  });

  it('marks a live but idle slot STUCK no-progress', () => {
    expect(report({ statuses: [status({}, DEFAULT_STUCK_AFTER_MS + 1)] }).stuck[0].reason).toBe('no-progress');
  });

  it('keeps a fresh live slot and the exact idle boundary unstuck', () => {
    expect(report().stuck).toEqual([]);
    expect(report({ statuses: [status({}, DEFAULT_STUCK_AFTER_MS)] }).stuck).toEqual([]);
  });

  it('counts ancient files without listing or probing them; ignores completed slots', () => {
    const aliveFn = vi.fn(() => true);
    const result = report({ statuses: [status({}, MAX_AGE_MS + 1), status({ status: 'done' })], aliveFn });
    expect(result.ancientOrphans).toBe(1);
    expect(result.slots).toEqual([]);
    expect(aliveFn).not.toHaveBeenCalled();
  });

  it('uses admission fields before birthtime, only mtime for progress, and extracts provider', () => {
    const admittedAt = '2026-11-11T10:00:00Z';
    const slot = report({ statuses: [status({ admittedAt, result: { provider: 'codex' } })] }).slots[0];
    expect(slot.admittedAt).toBe(new Date(admittedAt).toISOString());
    expect(slot.lastProgressAt).toBe(new Date(now - 1000).toISOString());
    expect(slot.idleMs).toBe(1000);
    expect(slot.seat).toBe('codex');
    expect(report().slots[0].admittedAt).toBe(new Date(now - 5000).toISOString());
  });

  it('flags queue rows without the same repo, PR and head occupied', () => {
    const row = { key: 'org/repo#42', repo: 'org/repo', pr: 42, head: 'abcdef1234567', attempts: 2 };
    const changedHead = { ...row, head: 'new-head' };
    const foreignRepo = { ...row, repo: 'other/repo', key: 'other/repo#42' };
    expect(report({ queueRows: [row, changedHead, foreignRepo] }).queuedNotRunning).toEqual([changedHead, foreignRepo]);
  });

  it('bounds descendants by depth and count and strips terminal controls', () => {
    const chain = Array.from({ length: 10 }, (_, i) => ({ pid: i + 101, ppid: i + 100, etime: '1', command: 'x'.repeat(200) }));
    expect(slotChildren(100, chain)).toHaveLength(6);
    expect(slotChildren(100, chain)[0].command).toHaveLength(160);
    const wide = Array.from({ length: 30 }, (_, i) => ({ pid: i + 101, ppid: 100, etime: '1', command: 'child' }));
    expect(slotChildren(100, wide)).toHaveLength(20);
    expect(formatSlotReport(report({ statuses: [status({ repo: 'org/\u001b[31mrepo' })] }))).not.toContain('\u001b');
  });

  it('refuses incomplete status and malformed process evidence', () => {
    expect(() => report({ statuses: [status({ head: null })] })).toThrow('identity');
    expect(() => report({ statuses: [{ ...status(), mtimeMs: NaN }] })).toThrow('mtime');
    expect(() => parseSlotPsRows('incomplete')).toThrow('snapshot');
  });
});

describe('threshold cascade', () => {
  const threshold = options => resolveSlotThreshold(options).value.slotStuckAfterMs;
  it('resolves standard, platform, tool, environment precedence and source', () => {
    expect(threshold({})).toBe(DEFAULT_STUCK_AFTER_MS);
    expect(threshold({ platform: { slotStuckAfterMs: 100 } })).toBe(100);
    const options = { platform: { slotStuckAfterMs: 100 }, file: { redTeam: { slotStuckAfterMs: 200 } } };
    expect(threshold(options)).toBe(200);
    expect(resolveSlotThreshold({ ...options, env: { WE_RED_TEAM_SLOT_STUCK_AFTER_MS: '300' } }))
      .toMatchObject({ value: { slotStuckAfterMs: 300 }, sources: { slotStuckAfterMs: 'env' } });
  });
  it.each(['', 'bad', '0', '-1', 'Infinity', '1.5'])('defaults an invalid environment override %j', raw => {
    expect(threshold({ file: { redTeam: { slotStuckAfterMs: 500 } }, env: { WE_RED_TEAM_SLOT_STUCK_AFTER_MS: raw } }))
      .toBe(DEFAULT_STUCK_AFTER_MS);
  });
  it.each([0, -10, '100', null, 1.5])('defaults an invalid tool setting %j', value => {
    expect(threshold({ file: { redTeam: { slotStuckAfterMs: value } } })).toBe(DEFAULT_STUCK_AFTER_MS);
  });
});

describe('process identity probes', () => {
  const io = { killAlive: () => true, readStart: () => 'Wed Nov 11 10:00:00 2026', host: 'local', namespace: 'ns' };
  it('detects pid reuse and normalizes ps timestamp spacing', () => {
    expect(probeSlotAlive({ pid: 100, pidStart: 'old' }, io)).toBe(false);
    expect(probeSlotAlive({ pid: 100, pidStart: 'Wed Nov  11 10:00:00 2026' }, io)).toBe(true);
  });
  it('reports unknown for unreadable start or foreign identity without attributing children', () => {
    expect(probeSlotAlive({ pid: 100, pidStart: 'old' }, { ...io, readStart: () => null })).toBeNull();
    const killAlive = vi.fn();
    expect(probeSlotAlive({ host: 'remote' }, { ...io, killAlive })).toBeNull();
    expect(probeSlotAlive({ pidNamespace: 'other' }, { ...io, killAlive })).toBeNull();
    expect(killAlive).not.toHaveBeenCalled();
    expect(report({ aliveFn: () => null }).slots[0].children).toEqual([]);
  });
  it('treats EPERM as alive and ESRCH as dead without real process probes', () => {
    expect(pidAlive(100, () => { throw Object.assign(new Error(), { code: 'EPERM' }); })).toBe(true);
    expect(pidAlive(100, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); })).toBe(false);
  });
});

describe('bounded status scan', () => {
  function scanIo(count, mtimeMs = now) {
    let index = 0;
    const closeSync = vi.fn();
    return { openDir: () => ({ readSync: () => index < count ? { name: `${index++}.json` } : null, closeSync }),
      closeSync, now, stat: () => ({ isFile: () => true, size: 10, mtimeMs, birthtimeMs: now }),
      readFile: vi.fn(() => JSON.stringify(status().data)) };
  }
  it('accepts 20000 files and refuses overflow with an operator fallback', () => {
    expect(readSlotStatuses('statuses', scanIo(20000))).toHaveLength(20000);
    const io = scanIo(20001);
    expect(() => readSlotStatuses('statuses', io)).toThrow('inspect/archive');
    expect(io.closeSync).toHaveBeenCalledOnce();
  });
  it('counts ancient files without reading their contents', () => {
    const io = scanIo(2, now - MAX_AGE_MS - 1);
    expect(report({ statuses: readSlotStatuses('statuses', io) }).ancientOrphans).toBe(2);
    expect(io.readFile).not.toHaveBeenCalled();
  });
  it('skips unreadable or oversized recent files instead of aborting', () => {
    const io = scanIo(1);
    io.readFile = () => { throw new Error('unreadable'); };
    expect(readSlotStatuses('statuses', io)).toEqual([]);
    const oversized = scanIo(1);
    oversized.stat = () => ({ isFile: () => true, size: 20 * 1024 * 1024 });
    expect(readSlotStatuses('statuses', oversized)).toEqual([]);
  });
});

describe('opt-in stuck event emission', () => {
  it('deduplicates persisted keys across runs and emits changed identities', async () => {
    const stuck = report({ aliveFn: () => false }).stuck;
    const appendEvent = vi.fn(async () => true);
    let persisted = {};
    const saveState = vi.fn(value => { persisted = value; });
    await emitStuckSlots(stuck, { state: persisted, appendEvent, saveState, now });
    await emitStuckSlots(stuck, { state: persisted, appendEvent, saveState, now });
    expect(appendEvent).toHaveBeenCalledOnce();
    expect(appendEvent.mock.calls[0][0]).toMatchObject({ kind: 'red-team-slot-stuck', pr: 42,
      daemon: 'red-team-slots', detail: { pid: 100, reason: 'pid-dead', idleMs: 1000, children: 0 } });
    await emitStuckSlots([{ ...stuck[0], pid: 101 }], { state: persisted, appendEvent, saveState, now });
    expect(appendEvent).toHaveBeenCalledTimes(2);
  });
  it('bounds persisted state to 200 entries', async () => {
    const state = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`old-${i}`, i]));
    const next = await emitStuckSlots(report({ aliveFn: () => false }).stuck,
      { state, appendEvent: async () => true, saveState: () => {}, now });
    expect(Object.keys(next)).toHaveLength(200);
    expect(next).not.toHaveProperty('old-0');
  });
  it('does not advance state when event append fails', async () => {
    const saveState = vi.fn();
    await expect(emitStuckSlots(report({ aliveFn: () => false }).stuck,
      { state: {}, appendEvent: async () => false, saveState, now })).rejects.toThrow('not advanced');
    expect(saveState).not.toHaveBeenCalled();
  });
});
