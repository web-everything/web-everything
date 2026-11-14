// @vitest-environment node
const operatorHome = vi.hoisted(() => ({ path: undefined }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, userInfo: (...args) => ({ ...actual.userInfo(...args), homedir: operatorHome.path ?? actual.userInfo(...args).homedir }) };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { tryAcquireNumberingLock, releaseNumberingLockIfOwned, makeOwner } from '../../readiness/drain-lock.mjs';

// The proposed writer API is synchronous, just like the settings readers. Observe real disk IO,
// including publication order and failures, rather than only checking the final JSON.
const io = { events: [], fail: null };
const writerIO = {
  appendFileSync: (...args) => {
    io.events.push(['append', ...args]);
    if (io.fail === 'append') throw new Error('audit unavailable');
    return appendFileSync(...args);
  },
  writeFileSync: (...args) => { io.events.push(['write', ...args]); return writeFileSync(...args); },
  renameSync: (...args) => {
    io.events.push(['rename', ...args]);
    if (io.fail === 'rename') throw new Error('publish unavailable');
    return renameSync(...args);
  },
};

let dir, file, store;
const key = 'reviewConcurrency.maxLiveReviewRounds';
const actor = 'capacity operator';
const write = (value, extra = {}) => store.writeOperatorOverride({ file, key, value, reason: 'capacity experiment', actor, io: writerIO, ...extra });
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'operator-overrides-'));
  file = join(dir, 'operator-overrides.json');
  operatorHome.path = join(dir, 'home');
  io.events = []; io.fail = null;
  store = await import('../operator-override-store.mjs');
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

const ranges = [
  ['reviewConcurrency.maxLiveReviewRounds', 1, 8],
  ['host.maxReviewDispatchPerTick', 1, 8],
  ['resourceGate.fixCap.floor', 1, 12],
  ['resourceGate.fixCap.ceiling', 1, 12],
  ['resourceGate.fixCap.raiseMinMemFreePct', 25, 60],
  ['redTeamQueue.minConcurrent', 0, 12],
];

describe('capacity-only operator store', () => {
  it('exports exactly the closed capacity allowlist', () => {
    expect(Object.keys(store.CAPACITY_LEAVES).sort()).toEqual(ranges.map(([k]) => k).sort());
  });
  it.each(ranges)('%s declares a safe direction and finite fail-closed fallback', key => {
    const leaf = store.CAPACITY_LEAVES[key];
    expect(leaf.direction).toBe(key.endsWith('raiseMinMemFreePct') ? 'threshold' : 'cap');
    expect(Number.isFinite(leaf.failClosedFallback)).toBe(true);
    expect(leaf.validate(leaf.failClosedFallback)).toBe(true);
    if (key === 'reviewConcurrency.maxLiveReviewRounds') expect(leaf.failClosedFallback).toBe(3);
  });
  it.each(ranges)('%s accepts both hard endpoints', (key, min, max) => {
    write(min, { key });
    expect(store.readOperatorOverrides({ file }).values[key]).toBe(min);
    write(max, { key });
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
  it.each(['mergeQueue.refreshOnStaleMergeGate', 'resourceGate.cutover', 'host.capacity.memAvailableFloorMb', '__proto__', 'unknown.capacity', 'heavyAdmission.remote.maxConcurrent'])('refuses %s by name and points to the signed-attestation slice', key => {
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
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator-override:.*operator-db-unreadable.*using code value/);
  });
  it('unreadable store never throws and logs code fallback', () => {
    const log = vi.fn();
    expect(store.readOperatorOverrides({ file: dir, log })).toEqual({ readable: false, values: {} });
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator-override:.*operator-db-unreadable.*using code value/);
  });
  it('drops each unknown, wrong-type and out-of-range key while preserving valid siblings', () => {
    writeFileSync(file, JSON.stringify({ [key]: 4, 'host.maxReviewDispatchPerTick': '3',
      'redTeamQueue.minConcurrent': 13, 'mergeQueue.refreshOnStaleMergeGate': false }));
    const log = vi.fn();
    expect(store.readOperatorOverrides({ file, log }).values[key]).toBe(4);
    for (const ignored of ['host.maxReviewDispatchPerTick', 'redTeamQueue.minConcurrent', 'mergeQueue.refreshOnStaleMergeGate']) {
      expect(log.mock.calls.some(([line]) => /operator-db-(unreadable|invalid)/.test(line) && line.includes(ignored))).toBe(true);
    }
  });
  it('R907: env-selected path changes neither the fixed host reader nor writer; file remains an explicit seam', () => {
    const fixed = join(operatorHome.path, '.claude', 'operator-overrides.json');
    mkdirSync(join(operatorHome.path, '.claude'), { recursive: true });
    writeFileSync(fixed, JSON.stringify({ [key]: 2 }));
    writeFileSync(file, JSON.stringify({ [key]: 5 }));
    vi.stubEnv('WE_OPERATOR_OVERRIDE_FILE', file);
    expect(store.readOperatorOverrides().values).toEqual({ [key]: 2 });
    store.writeOperatorOverride({ key, value: 3, reason: 'fixed host path', actor });
    expect(JSON.parse(readFileSync(fixed, 'utf8'))).toEqual({ [key]: 3 });
    expect(store.readOperatorOverrides({ file }).values).toEqual({ [key]: 5 });
    write(4);
    expect(store.readOperatorOverrides({ file }).values).toEqual({ [key]: 4 });
    expect(JSON.parse(readFileSync(fixed, 'utf8'))).toEqual({ [key]: 3 });
    store.clearOperatorOverride({ key, reason: 'fixed host clear', actor });
    expect(JSON.parse(readFileSync(fixed, 'utf8'))).toEqual({});
    expect(store.readOperatorOverrides({ file }).values).toEqual({ [key]: 4 });
  });
  it('stores flat dotted JSON, preserves siblings, and appends ISO audit records for set and clear', () => {
    write(2); write(3); write(7, { key: 'host.maxReviewDispatchPerTick' });
    store.clearOperatorOverride({ file, key, reason: 'experiment over', actor });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'host.maxReviewDispatchPerTick': 7 });
    const rows = readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ actor, osUser: userInfo().username, reason: 'capacity experiment', key, old: null, new: 2, source: 'operator-cli' });
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
  it('audit append failure preserves the existing override store and propagates failure', () => {
    write(2); const before = readFileSync(file); io.events = []; io.fail = 'append';
    expect(() => write(3)).toThrow(/audit unavailable/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [key]: 2 });
    expect(readFileSync(file)).toEqual(before);
    expect(io.events.map(([op]) => op)).toEqual(['append']);
    io.fail = null; write(4); // Failure also releases the transaction lock.
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
  it('real audit append failure preserves the existing store byte-for-byte', () => {
    writeFileSync(file, `{ "${key}": 2 }\n`);
    const before = readFileSync(file);
    const audit = join(dir, 'operator-overrides.log.jsonl');
    mkdirSync(audit);
    expect(() => store.writeOperatorOverride({ file, key, value: 3, reason: 'probe', actor })).toThrow();
    expect(readFileSync(file)).toEqual(before);
    rmSync(audit, { recursive: true });
    write(4);
    expect(store.readOperatorOverrides({ file }).values[key]).toBe(4);
  });
  it('occupied transaction lock refuses publication and names the operator fallback', () => {
    write(2);
    const owner = makeOwner('operator-override-test');
    const lockRoot = `${file}.locks`, lockPath = '<operator-overrides:transaction>';
    expect(tryAcquireNumberingLock(lockRoot, owner, { lockPath }).ok).toBe(true);
    const before = readFileSync(file), audit = readFileSync(join(dir, 'operator-overrides.log.jsonl'));
    try {
      expect(() => write(3, { lockWaitMs: 0 })).toThrow(/store lock unavailable.*retry.*operator/);
      expect(readFileSync(file)).toEqual(before);
      expect(readFileSync(join(dir, 'operator-overrides.log.jsonl'))).toEqual(audit);
    } finally { releaseNumberingLockIfOwned(lockRoot, owner, lockPath); }
    write(4);
  });
  it.each([-1, 5001, Infinity, '5'])('rejects invalid lock wait bound %s before changing the store', lockWaitMs => {
    expect(() => write(3, { lockWaitMs })).toThrow(/0\.\.5000.*retry/);
    expect(readdirSync(dir)).toEqual([]);
  });
  it('concurrent host-wide writers serialize transactions and preserve both keys', async () => {
    // Use a native file URL: the browser test environment may expose an HTTP import.meta.url.
    const moduleUrl = pathToFileURL(resolve('scripts/lib/operator-override-store.mjs')).href;
    const owner = makeOwner('concurrent-test-barrier');
    const lockRoot = `${file}.locks`, lockPath = '<operator-overrides:transaction>';
    expect(tryAcquireNumberingLock(lockRoot, owner, { lockPath }).ok).toBe(true);
    const code = `
      import { writeOperatorOverride } from ${JSON.stringify(moduleUrl)};
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const mkdir = fs.mkdirSync;
      let reported = false;
      fs.mkdirSync = (...args) => {
        try { return mkdir(...args); }
        catch (error) {
          if (!reported && error.code === 'EEXIST' && String(args[0]).startsWith(process.argv[1] + '.locks/')) {
            reported = true;
            process.send('contended');
          }
          throw error;
        }
      };
      syncBuiltinESMExports();
      writeOperatorOverride({ file: process.argv[1], key: process.argv[2], value: 3,
        reason: 'concurrent regression', actor: 'test process' });
      process.disconnect();`;
    const children = [key, 'host.maxReviewDispatchPerTick'].map(k => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, k],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      // Bound diagnostic output even if a child fails before its handshake.
      let stderr = '';
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(Error(`writer exit ${code}: ${stderr}`)));
      });
      const ready = new Promise((resolve, reject) => {
        child.once('message', message => message === 'contended' ? resolve() : reject(Error(`unexpected handshake: ${message}`))); child.once('error', reject);
        child.once('exit', code => reject(Error(`writer exited before handshake: ${code}: ${stderr}`)));
      });
      // Observe both promises immediately, including an early child error.
      done.catch(() => {}); ready.catch(() => {});
      return { child, done, ready };
    });
    try {
      await Promise.all(children.map(c => c.ready));
      // Both processes have attempted the same occupied lock; neither may read/publish early.
      expect(existsSync(file)).toBe(false);
      expect(existsSync(join(dir, 'operator-overrides.log.jsonl'))).toBe(false);
      releaseNumberingLockIfOwned(lockRoot, owner, lockPath);
      await Promise.all(children.map(c => c.done));
      expect(store.readOperatorOverrides({ file }).values).toEqual({ [key]: 3, 'host.maxReviewDispatchPerTick': 3 });
      expect(readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)).toHaveLength(2);
    } finally {
      releaseNumberingLockIfOwned(lockRoot, owner, lockPath);
      children.forEach(c => { if (c.child.exitCode === null) c.child.kill('SIGKILL'); });
      await Promise.allSettled(children.map(c => c.done));
    }
  }, 15000);

});

it('R907 lowering a stored operator ceiling also lowers its stored floor', () => {
  write(7, { key: 'resourceGate.fixCap.floor' });
  write(1, { key: 'resourceGate.fixCap.ceiling' });
  expect(store.readOperatorOverrides({ file }).values).toMatchObject({
    'resourceGate.fixCap.floor': 1, 'resourceGate.fixCap.ceiling': 1,
  });
});

it('R907 persisted inverted bounds retain the hard ceiling and lower the floor', () => {
  writeFileSync(file, JSON.stringify({ 'resourceGate.fixCap.floor': 7, 'resourceGate.fixCap.ceiling': 1 }));
  expect(store.readOperatorOverrides({ file }).values).toMatchObject({
    'resourceGate.fixCap.floor': 1, 'resourceGate.fixCap.ceiling': 1,
  });
});

it.each(['write', 'clear'])('R907 default %s ignores the env-selected path', operation => {
  const fixed = join(operatorHome.path, '.claude', 'operator-overrides.json');
  mkdirSync(join(operatorHome.path, '.claude'), { recursive: true });
  writeFileSync(fixed, JSON.stringify({ [key]: 2 }));
  writeFileSync(file, JSON.stringify({ [key]: 5 }));
  vi.stubEnv('WE_OPERATOR_OVERRIDE_FILE', file);
  const options = { key, value: 3, reason: 'fixed path regression', actor };
  if (operation === 'write') store.writeOperatorOverride(options);
  else store.clearOperatorOverride(options);
  expect(JSON.parse(readFileSync(fixed, 'utf8'))).toEqual(operation === 'write' ? { [key]: 3 } : {});
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [key]: 5 });
});

const auditRows = () => readFileSync(join(dir, 'operator-overrides.log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const FLOOR = 'resourceGate.fixCap.floor';
const CEILING = 'resourceGate.fixCap.ceiling';
const replayAudit = rows => {
  const state = {};
  for (const row of rows) { if (row.new === null) delete state[row.key]; else state[row.key] = row.new; }
  return state;
};

describe('normalized writes return and audit every effective change', () => {
  it('a floor write above the stored ceiling reports and audits the value actually stored', () => {
    write(1, { key: CEILING });
    const result = write(7, { key: FLOOR });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [CEILING]: 1, [FLOOR]: 1 });
    expect(result).toMatchObject({ key: FLOOR, old: null, new: 1, requested: 7 });
    expect(auditRows().at(-1)).toMatchObject({ key: FLOOR, old: null, new: 1, requested: 7 });
  });
  it('a ceiling write below the stored floor audits the secondary floor change as its own row', () => {
    write(7, { key: FLOOR });
    const result = write(3, { key: CEILING });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [FLOOR]: 3, [CEILING]: 3 });
    expect(result.changes).toEqual([
      { key: CEILING, old: null, new: 3 }, { key: FLOOR, old: 7, new: 3 },
    ]);
    expect(auditRows().slice(-2)).toMatchObject([{ key: CEILING, old: null, new: 3 }, { key: FLOOR, old: 7, new: 3 }]);
  });
  it('replaying the audit log reproduces the stored file after every write and clear', () => {
    write(5, { key: FLOOR }); write(2, { key: CEILING }); write(9, { key: FLOOR }); write(4, { key: CEILING });
    store.clearOperatorOverride({ file, key: CEILING, reason: 'reset', actor, io: writerIO });
    write(6, { key: key });
    expect(replayAudit(auditRows())).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
});

it('a hand-edited inverted store audits the floor the normalising write actually lowers', () => {
  writeFileSync(file, JSON.stringify({ [FLOOR]: 7, [CEILING]: 1 }));
  write(3);
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ [FLOOR]: 1, [CEILING]: 1, [key]: 3 });
  expect(auditRows()).toMatchObject([{ key, old: null, new: 3 }, { key: FLOOR, old: 7, new: 1 }]);
});
