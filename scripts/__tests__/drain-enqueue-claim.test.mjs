import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as claimModule from '../lib/drain-enqueue-claim.mjs';
import { createEnqueueClaims, withSerialEnqueueClaim } from '../lib/drain-enqueue-claim.mjs';

const roots = [];
const temp = () => { const dir = mkdtempSync(join(process.env.TMPDIR, 'enqueue-claim-')); roots.push(dir); return dir; };
const candidate = { repo: 'owner/repo', num: 7, headSha: 'head-a' };
const key = c => `${c.repo}#${c.num}@${c.headSha}`;
const filename = c => `${createHash('sha256').update(key(c)).digest('hex')}.json`;
const claim = (claims, c = candidate, kind = 'serial') => claims.claim({ ...c, kind });
const make = (dir = temp(), options = {}) => createEnqueueClaims({ dir, now: () => 100, pidAlive: () => true, ...options });
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('per-PR enqueue claims', () => {
  it('allows exactly one of concurrent same-head claimants to win', async () => {
    const dir = temp();
    const results = await Promise.all(Array.from({ length: 12 }, (_, pid) => Promise.resolve().then(() => claim(make(dir, { pid: pid + 1 })))));
    expect(results.filter(r => r.won)).toHaveLength(1);
    for (const result of results.filter(r => !r.won)) expect(result).toMatchObject({ reason: 'held', heldBy: { pid: 1, kind: 'serial' } });
  });

  it('holds live owners beyond ttlMs and past the default 60-minute hard cap', () => {
    const dir = temp();
    claim(make(dir));
    expect(claim(make(dir, { now: () => 600_101 }))).toMatchObject({ won: false, reason: 'held' });
    expect(claim(make(dir, { now: () => 3_600_100 }))).toMatchObject({ won: false, reason: 'held' });
    expect(claim(make(dir, { now: () => 3_600_101 }))).toMatchObject({ won: false, reason: 'held' });
  });

  it('keeps a live owner held past an injected hard cap', () => {
    const dir = temp();
    claim(make(dir));
    expect(claim(make(dir, { now: () => 1100, ttlMs: 10, hardTtlMs: 1000 }))).toMatchObject({ won: false, reason: 'held' });
    expect(claim(make(dir, { now: () => 1101, ttlMs: 10, hardTtlMs: 1000 }))).toMatchObject({ won: false, reason: 'held' });
  });

  it('reclaims a dead owner immediately before either TTL expires', () => {
    const dir = temp();
    claim(make(dir));
    expect(claim(make(dir, { pidAlive: () => false }))).toMatchObject({ won: true });
  });

  it('replaces an owner past the hard cap only after its PID is dead', () => {
    const dir = temp(); claim(make(dir));
    expect(claim(make(dir, { now: () => 1101, hardTtlMs: 1000, pidAlive: () => false })).won).toBe(true);
  });

  it('keys repository, PR number and new head independently', () => {
    const claims = make();
    for (const c of [candidate, { ...candidate, headSha: 'head-b' }, { ...candidate, repo: 'other/repo' }, { ...candidate, num: 8 }]) expect(claim(claims, c).won).toBe(true);
  });

  it('release and markDone ignore wrong tokens, including tokens from a replaced owner', () => {
    const dir = temp(); const claims = make(dir);
    const first = claim(claims);
    claims.release({ ...candidate, token: 'wrong' });
    claims.markDone({ ...candidate, token: 'wrong' });
    expect(claim(claims)).toMatchObject({ won: false, reason: 'held' });
    const next = claim(make(dir, { pidAlive: () => false }));
    claims.release({ ...candidate, token: first.token });
    claims.markDone({ ...candidate, token: first.token });
    expect(claim(claims).reason).toBe('held');
    claims.release({ ...candidate, token: next.token });
    expect(claim(claims).won).toBe(true);
  });

  it('done serial blocks fast until expiry but permits serial retries and stamps doneAt', () => {
    const dir = temp(); let clock = 100;
    const claims = make(dir, { now: () => clock, ttlMs: 1000 });
    const first = claim(claims); clock = 200;
    claims.markDone({ ...candidate, token: first.token });
    expect(JSON.parse(readFileSync(join(dir, filename(candidate)), 'utf8'))).toMatchObject({ state: 'done', doneAt: 200 });
    expect(claim(claims, candidate, 'fast')).toMatchObject({ won: false, reason: 'done-by-other', heldBy: { kind: 'serial' } });
    clock = 1201;
    expect(claim(claims, candidate, 'fast').won).toBe(true);
    claims.release({ ...candidate, token: JSON.parse(readFileSync(join(dir, filename(candidate)), 'utf8')).token });
    const second = claim(claims); claims.markDone({ ...candidate, token: second.token });
    expect(claim(claims).won).toBe(true);
  });

  it('protects a long enqueue from other kinds for a full TTL after doneAt', () => {
    let clock = 100; const ttlMs = 10_000;
    const claims = make(undefined, { now: () => clock, ttlMs });
    const first = claim(claims);
    clock = 100 + ttlMs + 1000;
    claims.markDone({ ...candidate, token: first.token });
    clock = 100 + ttlMs + 2000;
    expect(claim(claims, candidate, 'fast')).toMatchObject({ won: false, reason: 'done-by-other' });
    clock = 100 + 2 * ttlMs + 1000;
    expect(claim(claims, candidate, 'fast').reason).toBe('done-by-other');
    clock++;
    expect(claim(claims, candidate, 'fast').won).toBe(true);
  });

  it('falls back to claimedAt for persisted done records missing doneAt', () => {
    const dir = temp();
    writeFileSync(join(dir, filename(candidate)), JSON.stringify({ state: 'done', kind: 'serial', pid: 1, token: 'old', claimedAt: 100 }));
    expect(claim(make(dir, { now: () => 1100, ttlMs: 1000 }), candidate, 'fast').reason).toBe('done-by-other');
    expect(claim(make(dir, { now: () => 1101, ttlMs: 1000 }), candidate, 'fast').won).toBe(true);
  });

  it('uses shared coordination state across instances without leaving temporary files', () => {
    const root = temp(); const env = { WE_COORDINATION_ROOT: root };
    expect(claim(createEnqueueClaims({ env })).won).toBe(true);
    expect(claim(createEnqueueClaims({ env })).reason).toBe('held');
    expect(readdirSync(join(root, 'drain-enqueue-claim'))).toEqual([filename(candidate)]);
  });

  it('reclaims a lock older than five seconds', () => {
    const dir = temp(); const lock = join(dir, `${filename(candidate)}.lock`);
    mkdirSync(lock); const old = new Date(Date.now() - 6000); utimesSync(lock, old, old);
    expect(claim(make(dir)).won).toBe(true);
  });

  it.each([false, true])('exactly one claimant wins when two stale-lock reclaimers race with a live replacement (owner marker: %s)', marked => {
    const dir = temp(); const lock = join(dir, `${filename(candidate)}.lock`);
    mkdirSync(lock);
    if (marked) writeFileSync(join(lock, 'expired.owner'), '');
    const old = new Date(Date.now() - 6000); utimesSync(lock, old, old);
    const worker = `
      const { parentPort, workerData: d } = require('node:worker_threads');
      const fs = require('node:fs');
      const { syncBuiltinESMExports } = require('node:module');
      const gate = new Int32Array(d.shared);
      const wait = index => {
        if (Atomics.wait(gate, index, 0, 6000) === 'timed-out') throw new Error('interleaving barrier timed out');
      };
      if (d.role === 'late') {
        const original = fs.statSync; let observed = false;
        fs.statSync = function(path, ...args) {
          const stat = original.call(this, path, ...args);
          if (path === d.lock && !observed) {
            observed = true;
            parentPort.postMessage({ observed: true });
            wait(0); // Keep the expired directory's stat while the other worker replaces it.
          }
          return stat;
        };
        syncBuiltinESMExports();
      }
      (async () => {
        const { createEnqueueClaims } = await import(d.moduleUrl);
        const claims = createEnqueueClaims({ dir: d.dir, pidAlive: () => true, now: () => {
          if (d.role === 'first') {
            // The replacement lock is held and the record has already been read as absent.
            Atomics.store(gate, 0, 1); Atomics.notify(gate, 0);
            wait(1);
          }
          return 100;
        } });
        try { parentPort.postMessage({ result: claims.claim({ ...d.candidate, kind: 'serial' }) }); }
        finally { if (d.role === 'late') { Atomics.store(gate, 1, 1); Atomics.notify(gate, 1); } }
      })().catch(error => { throw error; });
    `;
    const program = `
      import { Worker } from 'node:worker_threads';
      const shared = new SharedArrayBuffer(8);
      const data = ${JSON.stringify({ dir, lock, candidate, moduleUrl: pathToFileURL(join(process.cwd(), 'scripts/lib/drain-enqueue-claim.mjs')).href })};
      const start = (role, observed = () => {}) => new Promise((resolve, reject) => {
        const worker = new Worker(${JSON.stringify(worker)}, { eval: true, workerData: { ...data, role, shared } });
        worker.on('message', message => { if (message.observed) observed(); else resolve(message.result); });
        worker.on('error', reject);
      });
      let first;
      const late = start('late', () => { first = start('first'); });
      const lateResult = await late;
      console.log(JSON.stringify([await first, lateResult]));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const results = JSON.parse(result.stdout);
    expect(results.filter(row => row.won)).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, filename(candidate)), 'utf8')).token).toBe(results.find(row => row.won).token);
  }, 20_000);

  it('returns lock-busy within a bounded wait without disturbing a fresh lock', () => {
    const dir = temp(); const lock = join(dir, `${filename(candidate)}.lock`); mkdirSync(lock);
    const started = performance.now();
    expect(claim(make(dir))).toEqual({ won: false, reason: 'lock-busy' });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(readdirSync(dir)).toEqual([`${filename(candidate)}.lock`]);
  });

  it('leaves unknown stale lock contents intact and returns lock-busy', () => {
    const dir = temp(); const lock = join(dir, `${filename(candidate)}.lock`); mkdirSync(lock);
    writeFileSync(join(lock, 'unknown'), 'keep');
    const old = new Date(Date.now() - 6000); utimesSync(lock, old, old);
    expect(claim(make(dir))).toEqual({ won: false, reason: 'lock-busy' });
    expect(readFileSync(join(lock, 'unknown'), 'utf8')).toBe('keep');
    expect(readdirSync(dir)).toEqual([`${filename(candidate)}.lock`]);
  });

  it.each(['{broken', 'null', '{}', '{"state":"claimed","pid":0}'])('holds fresh corrupt or invalid records and reclaims only past ttlMs: %s', source => {
    const dir = temp(); const path = join(dir, filename(candidate)); writeFileSync(path, source);
    utimesSync(path, new Date(1000), new Date(1000));
    expect(claim(make(dir, { now: () => 1999, ttlMs: 1000 }))).toEqual({ won: false, reason: 'unreadable-record' });
    expect(claim(make(dir, { now: () => 2000, ttlMs: 1000 }))).toEqual({ won: false, reason: 'unreadable-record' });
    expect(readFileSync(path, 'utf8')).toBe(source);
    const result = claim(make(dir, { now: () => 2001, ttlMs: 1000 }));
    expect(result.won).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ state: 'claimed', token: result.token });
  });

  it('treats EPERM from the injected PID probe as alive and ESRCH as dead', () => {
    const dir = temp(); claim(make(dir));
    const probe = code => () => { throw Object.assign(new Error(code), { code }); };
    expect(claim(make(dir, { pidAlive: probe('EPERM') }))).toMatchObject({ won: false, reason: 'held' });
    expect(claim(make(dir, { pidAlive: probe('ESRCH') }))).toMatchObject({ won: true });
  });

  it('treats EPERM from the default process.kill probe as alive', () => {
    const dir = temp(); claim(make(dir));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); });
    expect(claim(make(dir, { pidAlive: undefined }))).toMatchObject({ won: false, reason: 'held' });
  });

  it('holds a fresh unreadable record rather than throwing a storage fault', () => {
    const dir = temp(); mkdirSync(join(dir, filename(candidate)));
    expect(claim(make(dir))).toEqual({ won: false, reason: 'unreadable-record' });
  });

  it('reclaims an unreadable file only after its mtime TTL expires', () => {
    const dir = temp(); const path = join(dir, filename(candidate));
    writeFileSync(path, 'unreadable'); utimesSync(path, new Date(1000), new Date(1000));
    const program = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createEnqueueClaims } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/lib/drain-enqueue-claim.mjs')).href)};
      const read = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        if (path === ${JSON.stringify(path)}) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return read.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      let clock = 2000;
      const claims = createEnqueueClaims({ dir: ${JSON.stringify(dir)}, now: () => clock, ttlMs: 1000 });
      const candidate = ${JSON.stringify({ ...candidate, kind: 'serial' })};
      const fresh = claims.claim(candidate);
      clock = 2001;
      console.log(JSON.stringify([fresh, claims.claim(candidate)]));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ won: false, reason: 'unreadable-record' }, { won: true, token: expect.any(String) }]);
    expect(JSON.parse(readFileSync(path, 'utf8')).state).toBe('claimed');
  });

  it('property: serial enqueue lists are identical with claims enabled or disabled', () => {
    let seed = 44;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let trial = 0; trial < 60; trial++) {
      const candidates = Array.from({ length: random() % 30 }, () => ({ ...candidate, num: random() % 5, headSha: `head-${random() % 3}`, outcome: random() % 3 }));
      const run = enabled => {
        const claims = make(); const enqueued = [];
        const enqueue = c => { if (c.outcome === 0) throw new Error('enqueue failed'); if (c.outcome === 1) enqueued.push(key(c)); return { enqueued: c.outcome === 1 }; };
        for (const c of candidates) {
          const result = enabled ? claim(claims, c) : { won: true };
          if (!result.won) continue;
          try {
            const outcome = enqueue(c);
            if (enabled) claims[outcome.enqueued ? 'markDone' : 'release']({ ...c, token: result.token });
          } catch { if (enabled) claims.release({ ...c, token: result.token }); }
        }
        return enqueued;
      };
      expect(run(true)).toEqual(run(false));
    }
  });
});

describe('serial enqueue claim diagnostics', () => {
  const warning = op => `drain-enqueue-claim: ${op} failed for owner/repo#7@head-a: broken storage — proceeding fail-open\n`;

  it('warns on initialization failure at the serial call site and leaves claims disabled', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/merge-ai-prs.mjs'), 'utf8');
    const start = source.indexOf('try { enqueueClaims = createEnqueueClaims(); }');
    const end = source.indexOf('    try {\n      asyncShadow', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const stderr = { write: vi.fn() };
    const initialize = new Function('createEnqueueClaims', 'process', `let enqueueClaims; ${source.slice(start, end)}; return enqueueClaims;`);
    expect(initialize(() => { throw new Error('broken\nstorage'); }, { stderr })).toBeUndefined();
    expect(stderr.write.mock.calls).toEqual([['drain-enqueue-claim: initialization failed: broken storage — proceeding fail-open\n']]);
  });

  it('still enqueues and warns once with a daemon event when claim throws', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const emit = vi.fn(); const run = vi.fn(() => ({ enqueued: true }));
    const claims = { claim() { throw new Error('broken\nstorage'); } };
    expect(withSerialEnqueueClaim(claims, candidate, run, { emit })).toEqual({ enqueued: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls).toEqual([[warning('claim')]]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ repo: candidate.repo, pr: 7,
      detail: { op: 'claim', headSha: 'head-a', message: 'broken storage' } }));
  });

  it.each([true, false])('preserves the enqueue result and warns on bookkeeping errors (enqueued: %s)', enqueued => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const op = enqueued ? 'markDone' : 'release';
    const claims = { claim: () => ({ won: true, token: 'owned' }),
      [op]: vi.fn(() => { throw new Error('broken storage'); }) };
    const result = { enqueued };
    expect(withSerialEnqueueClaim(claims, candidate, () => result, { emit() { throw new Error('event failed'); } })).toBe(result);
    expect(claims[op]).toHaveBeenCalledWith({ ...candidate, token: 'owned' });
    expect(stderr.mock.calls).toEqual([[warning(op)]]);
  });

  it('preserves the original enqueue error when release also throws and warns', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const error = new Error('enqueue failed');
    const claims = { claim: () => ({ won: true, token: 'owned' }), release() { throw new Error('broken storage'); } };
    expect(() => withSerialEnqueueClaim(claims, candidate, () => { throw error; }, { emit: () => Promise.reject(new Error('event failed')) })).toThrow(error);
    expect(stderr.mock.calls).toEqual([[warning('release')]]);
  });

  it.each(['claim', 'release', 'markDone'])('warns when %s returns lock-busy without changing the serial outcome', op => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const claims = { claim: () => ({ won: true, token: 'owned' }), [op]: () => ({ won: false, reason: 'lock-busy' }) };
    const result = { enqueued: op === 'markDone' }; const run = vi.fn(() => result);
    expect(withSerialEnqueueClaim(claims, candidate, run, { emit: vi.fn() })).toEqual(op === 'claim' ? { skipped: 'claimed-elsewhere' } : result);
    expect(run).toHaveBeenCalledTimes(op === 'claim' ? 0 : 1);
    expect(stderr.mock.calls).toEqual([[warning(op).replace('broken storage', 'lock-busy')]]);
  });
});

describe('explicit claim fault policy', () => {
  const faults = [
    ['undefined store', () => undefined],
    ['throwing store', () => ({ claim() { throw new Error('broken storage'); } })],
    ['missing claim method', () => ({})],
    ['undefined result', () => ({ claim: () => undefined })],
    ['incomplete result', () => ({ claim: () => ({}) })],
    ['reported fault', () => ({ claim: () => ({ won: false, reason: 'claim-fault' }) })],
    ['lock fault', () => ({ claim: () => ({ won: false, reason: 'lock-busy' }) })],
  ];
  it.each(faults)('async fails closed on %s and warns visibly', (_name, store) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    expect(claimModule.claimOrFault(store(), { ...candidate, kind: 'fast' }, { mode: 'async', emit: vi.fn() }))
      .toEqual({ won: false, reason: 'claim-fault' });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-closed'));
  });
  it.each(faults)('serial fails open on %s and warns visibly', (name, store) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const result = claimModule.claimOrFault(store(), candidate, { mode: 'serial', emit: vi.fn() });
    expect(result).toEqual(name === 'lock fault' ? { won: false, reason: 'lock-busy' } : { won: true });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });
  it.each(['serial', 'async'])('%s preserves ownership wins and explicit refusals', mode => {
    for (const result of [{ won: true, token: 'owned' }, ...['held', 'done-by-other', 'unreadable-record'].map(reason => ({ won: false, reason }))]) {
      const claims = { claim: vi.fn(() => result) };
      expect(claimModule.claimOrFault(claims, candidate, { mode })).toBe(result);
      expect(claims.claim).toHaveBeenCalledWith(candidate);
    }
  });
  it('serial wrapper enqueues and warns when the store is undefined', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const run = vi.fn(() => ({ enqueued: true }));
    expect(withSerialEnqueueClaim(undefined, candidate, run, { emit: vi.fn() })).toEqual({ enqueued: true });
    expect(run).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fail-open'));
  });
});
