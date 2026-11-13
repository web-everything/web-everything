import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

// The proposed writer API is synchronous, just like the settings readers. Observe real disk IO,
// including publication order and failures, rather than only checking the final JSON.
const io = vi.hoisted(() => ({ events: [], fail: null }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal();
  return { ...fs,
    appendFileSync: (...args) => {
      io.events.push(['append', ...args]);
      if (io.fail === 'append') throw new Error('audit unavailable');
      return fs.appendFileSync(...args);
    },
    writeFileSync: (...args) => { io.events.push(['write', ...args]); return fs.writeFileSync(...args); },
    renameSync: (...args) => {
      io.events.push(['rename', ...args]);
      if (io.fail === 'rename') throw new Error('publish unavailable');
      return fs.renameSync(...args);
    },
  };
});

let dir, file, store;
const key = 'reviewConcurrency.maxLiveReviewRounds';
const actor = `${userInfo().username}: capacity operator`;
const write = (value, extra = {}) => store.writeOperatorOverride({ file, key, value, reason: 'capacity experiment', actor, ...extra });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'operator-overrides-'));
  file = join(dir, 'operator-overrides.json');
  io.events = []; io.fail = null;
  store = await import('../operator-override-store.mjs');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const ranges = [
  ['reviewConcurrency.maxLiveReviewRounds', 1, 8],
  ['host.maxReviewDispatchPerTick', 1, 8],
  ['resourceGate.fixCap.floor', 1, 12],
  ['resourceGate.fixCap.ceiling', 1, 12],
  ['resourceGate.fixCap.raiseMinMemFreePct', 0, 100],
  ['redTeamQueue.minConcurrent', 0, 12],
  // Reader wiring is intentionally deferred: heavy-admission.mjs is outside this task's scope.
  ['heavyAdmission.remote.maxConcurrent', 1, 32],
];

describe('capacity-only operator store', () => {
  it('exports exactly the closed capacity allowlist', () => {
    expect(Object.keys(store.CAPACITY_LEAVES).sort()).toEqual(ranges.map(([k]) => k).sort());
  });
  it.each(ranges)('%s accepts both hard endpoints', (key, min, max) => {
    write(min, { key }); write(max, { key });
    expect(store.readOperatorOverrides({ file }).values[key]).toBe(max);
  });
  it.each(ranges)('%s rejects wrong types and values outside its hard range before any write', (key, min, max) => {
    for (const value of [min - 1, max + 1, String(min), null, true, NaN, Infinity, ...(key.endsWith('Pct') ? [] : [min + 0.5])]) {
      expect(() => write(value, { key })).toThrow(key);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
  it('accepts a fractional percentage', () => {
    write(42.5, { key: 'resourceGate.fixCap.raiseMinMemFreePct' });
    expect(store.readOperatorOverrides({ file }).values['resourceGate.fixCap.raiseMinMemFreePct']).toBe(42.5);
  });
  it.each(['mergeQueue.refreshOnStaleMergeGate', 'resourceGate.cutover', 'host.capacity.memAvailableFloorMb', '__proto__', 'unknown.capacity'])('refuses %s by name and points to the signed-attestation slice', key => {
    expect(() => write(1, { key })).toThrow(key);
    expect(() => write(1, { key })).toThrow(/guard leaves need the signed-attestation slice/i);
    expect(readdirSync(dir)).toEqual([]);
  });
  it.each(['', '   '])('requires a non-empty reason and actor (%j)', blank => {
    expect(() => write(3, { reason: blank })).toThrow(/reason/i);
    expect(() => write(3, { actor: blank })).toThrow(/actor/i);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('missing store is readable and empty without fallback logging', () => {
    const log = vi.fn();
    expect(store.readOperatorOverrides({ file, log })).toEqual({ readable: true, values: {} });
    expect(log).not.toHaveBeenCalled();
  });
  it.each(['{ truncated', '[]', 'null', '123', '"text"'])('unparseable/non-object store %s never throws and logs code fallback', body => {
    writeFileSync(file, body); const log = vi.fn();
    expect(store.readOperatorOverrides({ file, log })).toEqual({ readable: false, values: {} });
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator-override:.*using code value/);
  });
  it('unreadable store never throws and logs code fallback', () => {
    const log = vi.fn();
    expect(store.readOperatorOverrides({ file: dir, log })).toEqual({ readable: false, values: {} });
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator-override:.*using code value/);
  });
  it('drops each unknown, wrong-type and out-of-range key while preserving valid siblings', () => {
    writeFileSync(file, JSON.stringify({ [key]: 4, 'host.maxReviewDispatchPerTick': '3',
      'redTeamQueue.minConcurrent': 13, 'mergeQueue.refreshOnStaleMergeGate': false }));
    const log = vi.fn();
    expect(store.readOperatorOverrides({ file, log })).toEqual({ readable: true, values: { [key]: 4 } });
    for (const ignored of ['host.maxReviewDispatchPerTick', 'redTeamQueue.minConcurrent', 'mergeQueue.refreshOnStaleMergeGate']) {
      expect(log.mock.calls.some(([line]) => line.startsWith(`operator-override: ignored ${ignored} (`) && line.endsWith('; using code value'))).toBe(true);
    }
  });
  it('uses WE_OPERATOR_OVERRIDE_FILE when no file seam is supplied', () => {
    writeFileSync(file, JSON.stringify({ [key]: 5 })); vi.stubEnv('WE_OPERATOR_OVERRIDE_FILE', file);
    expect(store.readOperatorOverrides().values).toEqual({ [key]: 5 });
  });
  it('stores flat dotted JSON, preserves siblings, and appends ISO audit records for set and clear', () => {
    write(2); write(3); write(7, { key: 'host.maxReviewDispatchPerTick' });
    store.clearOperatorOverride({ file, key, reason: 'experiment over', actor });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'host.maxReviewDispatchPerTick': 7 });
    const rows = readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ actor, reason: 'capacity experiment', key, old: null, new: 2, source: 'operator-cli' });
    expect(rows[1]).toMatchObject({ old: 2, new: 3 });
    expect(rows[3]).toMatchObject({ actor, reason: 'experiment over', key, old: 3, new: null, source: 'operator-cli' });
    for (const row of rows) expect(new Date(row.ts).toISOString()).toBe(row.ts);
  });
  it('audits first, writes a sibling temporary file, then atomically renames it', () => {
    write(3);
    const append = io.events.findIndex(([op]) => op === 'append');
    const stage = io.events.findIndex(([op]) => op === 'write');
    const publish = io.events.findIndex(([op]) => op === 'rename');
    expect(append).toBeGreaterThanOrEqual(0); expect(stage).toBeGreaterThan(append); expect(publish).toBeGreaterThan(stage);
    const [, temporary] = io.events[stage];
    expect(temporary).not.toBe(file); expect(temporary.startsWith(dir + '/')).toBe(true);
    expect(io.events[publish].slice(1)).toEqual([temporary, file]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [key]: 3 });
  });
  it('audit failure prevents publication and preserves the previous store', () => {
    write(2); io.events = []; io.fail = 'append';
    expect(() => write(3)).toThrow(/audit unavailable/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [key]: 2 });
    expect(io.events.map(([op]) => op)).toEqual(['append']);
  });
  it('rename failure leaves the previous store readable', () => {
    write(2); io.fail = 'rename';
    expect(() => write(3)).toThrow(/publish unavailable/);
    expect(store.readOperatorOverrides({ file }).values).toEqual({ [key]: 2 });
  });
  it('clear also rejects guard leaves before writing', () => {
    expect(() => store.clearOperatorOverride({ file, key: 'mergeQueue.refreshOnStaleMergeGate', reason: 'clear', actor })).toThrow(/signed-attestation/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
