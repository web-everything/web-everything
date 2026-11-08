import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as store from '../run-store.mjs';

let dir;
const id = 'run-cas';
const sample = () => store.newRunRecord({ id, op: 'fixture-cas', input: { counter: 0 } });
const increment = (r) => { r.input.counter++; return r; };
const lockPath = () => join(dir, `${id}.lock`);
const lock = (over = {}) => ({ pid: process.pid, host: hostname(), token: 'fixture', at: Date.now(), ...over });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-run-cas-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Real processes wait on IPC: both have imported the module before the parent releases the barrier.
const childSource = `
  import { readRun, updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
  process.send('ready');
  process.once('message', ({ dir, id, expected, retry }) => {
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      const before = retry ? readRun(id, dir) : expected;
      result = updateRunIf(id, before, r => { r.input.counter++; return r; }, dir);
      if (!retry || result.applied || result.reason !== 'changed') break;
    }
    process.send(result, () => process.disconnect());
  });
`;
async function racers(count, message) {
  const children = Array.from({ length: count }, () => spawn(process.execPath,
    ['--input-type=module', '-e', childSource], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  try {
    await Promise.all(children.map(async (child) => {
      let stderr = '';
      child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8192); });
      const ready = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(([code]) => { throw new Error(`child exited ${code}: ${stderr}`); }),
      ]);
      expect(ready[0]).toBe('ready');
    }));
    const results = children.map((child) => once(child, 'message').then(([result]) => result));
    for (const child of children) child.send(message);
    return await Promise.all(results);
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }));
  }
}

describe('run store compare-and-swap', () => {
  it('keeps a destination created while legacy migration is paused after copying', async () => {
    const legacy = join(dir, 'legacy');
    const shared = join(dir, 'shared');
    mkdirSync(legacy);
    writeFileSync(store.runPath(id, legacy), JSON.stringify(sample()));
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { migrateLegacyRuns } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const copy = fs.copyFileSync;
      fs.copyFileSync = (...args) => {
        copy(...args);
        process.send('copied');
        fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      };
      syncBuiltinESMExports();
      process.send(migrateLegacyRuns(${JSON.stringify(legacy)}, ${JSON.stringify(shared)}), () => process.disconnect());
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
    try {
      expect((await once(child, 'message'))[0]).toBe('copied');
      store.writeRun({ ...sample(), input: { counter: 7 } }, shared);
      const destination = readFileSync(store.runPath(id, shared), 'utf8');
      const result = once(child, 'message');
      child.stdin.write('!');
      expect((await result)[0]).toEqual({ moved: [], skipped: [] });
      expect(readFileSync(store.runPath(id, shared), 'utf8')).toBe(destination);
      expect(readdirSync(shared)).toEqual([`${id}.json`]);
      expect(readdirSync(legacy)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });

  it('refuses an in-place change to a rev-less legacy snapshot without calling mutate', () => {
    const before = sample();
    writeFileSync(store.runPath(id, dir), JSON.stringify({ ...before, input: { counter: 9 } }));
    const text = readFileSync(store.runPath(id, dir), 'utf8');
    expect(store.updateRunIf(id, before, () => { throw new Error('must not mutate'); }, dir))
      .toEqual({ applied: false, reason: 'changed' });
    expect(readFileSync(store.runPath(id, dir), 'utf8')).toBe(text);
  });

  it('accepts canonical JSON equality for rev-less records despite nested key order', () => {
    const before = { ...sample(), input: { a: 1, nested: { x: 2, y: [1, 2] } } };
    writeFileSync(store.runPath(id, dir), JSON.stringify({
      ...Object.fromEntries(Object.entries(before).reverse()), input: { nested: { y: [1, 2], x: 2 }, a: 1 },
    }));
    expect(store.updateRunIf(id, before, r => r, dir).applied).toBe(true);
  });

  it.each(['waiter', 'guard', 'record'])('cleans its partial %s after an injected ENOSPC metadata write', kind => {
    store.writeRun(sample(), dir);
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readRun, updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const [dir, id, kind] = process.argv.slice(1);
      const before = readRun(id, dir);
      const open = fs.openSync, write = fs.writeFileSync;
      let target, injected = false;
      fs.openSync = (path, ...args) => {
        const fd = open(path, ...args);
        if (typeof path === 'string' && (kind === 'waiter' ? path.includes('.claim.waiter.') :
            path === dir + '/' + id + '.lock' + (kind === 'guard' ? '.claim' : ''))) target = fd;
        return fd;
      };
      fs.writeFileSync = (fd, ...args) => {
        if (!injected && fd === target) {
          injected = true;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        }
        return write(fd, ...args);
      };
      syncBuiltinESMExports();
      let code;
      try { updateRunIf(id, before, r => r, dir, { waitMs: 0 }); } catch (error) { code = error.code; }
      const files = fs.readdirSync(dir);
      const unchanged = readRun(id, dir);
      const retry = updateRunIf(id, before, r => r, dir, { waitMs: 0 });
      console.log(JSON.stringify({ code, injected, files, unchanged, retry }));
    `;
    const before = store.readRun(id, dir);
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source, dir, id, kind],
      { encoding: 'utf8' }));
    expect(result.code).toBe('ENOSPC');
    expect(result.injected).toBe(true);
    expect(result.files).toEqual([`${id}.json`]);
    expect(result.unchanged).toEqual(before);
    expect(result.retry.applied).toBe(true);
  });

  it.each(['', '{garbage'])('retains foreign malformed lock evidence %j at every acquisition level', text => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    for (const suffix of ['', '.claim', '.claim.waiter.foreign']) {
      const path = lockPath() + suffix;
      writeFileSync(path, text);
      expect(store.updateRunIf(id, before, increment, dir, { waitMs: 0, isPidAlive: () => false }))
        .toEqual({ applied: false, reason: 'locked' });
      expect(readFileSync(path, 'utf8')).toBe(text);
      rmSync(path);
    }
    expect(store.readRun(id, dir)).toEqual(before);
  });

  it('serializes plain writers revision allocation so a snapshot between them is changed', async () => {
    store.writeRun(sample(), dir);
    const initial = store.readRun(id, dir);
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { writeRun } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const [dir, id, role] = process.argv.slice(1);
      const pause = () => { process.send('paused'); fs.readSync(0, Buffer.alloc(1), 0, 1, null); };
      const read = fs.readFileSync, open = fs.openSync;
      let paused = false;
      // A pauses holding its disk snapshot. B pauses before acquiring the lock, or, in the
      // broken unlocked implementation, after reading the same old revision as A.
      fs.openSync = (path, ...args) => {
        if (role === 'B' && !paused && path === dir + '/' + id + '.lock.claim') {
          paused = true; pause();
        }
        return open(path, ...args);
      };
      fs.readFileSync = (path, ...args) => {
        const result = read(path, ...args);
        if (!paused && path === dir + '/' + id + '.json') { paused = true; pause(); }
        return result;
      };
      syncBuiltinESMExports();
      writeRun({ ...${JSON.stringify(initial)}, cursor: role === 'A' ? 1 : 2 }, dir);
      process.send('written', () => process.disconnect());
    `;
    const children = [];
    async function start(role) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, dir, id, role],
        { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      expect((await once(child, 'message'))[0]).toBe('paused');
      return child;
    }
    async function release(child) {
      const written = once(child, 'message');
      child.stdin.write('!');
      expect((await written)[0]).toBe('written');
    }
    try {
      const a = await start('A');
      const b = await start('B');
      await release(a);
      const snapshot = store.readRun(id, dir);
      await release(b);
      const latest = store.readRun(id, dir);
      expect(store.updateRunIf(id, snapshot, increment, dir)).toEqual({ applied: false, reason: 'changed' });
      expect([initial.rev, snapshot.rev, latest.rev]).toEqual([initial.rev, initial.rev + 1, initial.rev + 2]);
      expect(latest.cursor).toBe(2);
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }));
    }
  });

  it('plain writer times out behind a real CAS holder without overwriting its result', async () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    const source = `
      import { readSync } from 'node:fs';
      import { updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const result = updateRunIf(${JSON.stringify(id)}, ${JSON.stringify(before)}, r => {
        process.send('locked');
        readSync(0, Buffer.alloc(1), 0, 1, null);
        r.input.counter++;
        return r;
      }, ${JSON.stringify(dir)});
      process.send(result, () => process.disconnect());
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
    try {
      expect((await once(child, 'message'))[0]).toBe('locked');
      const held = readFileSync(lockPath(), 'utf8');
      const start = Date.now();
      expect(() => store.writeRun({ ...before, cursor: 1 }, dir, { waitMs: 50 }))
        .toThrow(/lock.*timed out/i);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(readFileSync(lockPath(), 'utf8')).toBe(held);
      expect(store.readRun(id, dir)).toEqual(before);
      const result = once(child, 'message');
      child.stdin.write('!');
      const [cas] = await result;
      expect(cas.applied).toBe(true);
      expect(store.readRun(id, dir)).toEqual(cas.record);
      expect(cas.record).toMatchObject({ rev: before.rev + 1, input: { counter: 1 } });
      expect(cas.record).not.toHaveProperty('cursor', 1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });

  it.each(['file', 'memory'])('accepts the last safe revision and refuses overflow (%s)', kind => {
    const handle = kind === 'file' ? store.createFileRunStore(dir) : store.createMemoryRunStore();
    const before = handle.write({ ...sample(), rev: Number.MAX_SAFE_INTEGER - 2 });
    const result = handle.updateIf(id, before, increment);
    expect(result.applied).toBe(true);
    expect(result.record.rev).toBe(Number.MAX_SAFE_INTEGER);
    // The maximum is valid evidence, so an older snapshot is changed, not unreadable.
    expect(handle.updateIf(id, before, increment)).toEqual({ applied: false, reason: 'changed' });
    const mutate = () => { throw new Error('must not mutate on overflow'); };
    expect(() => handle.updateIf(id, result.record, mutate)).toThrow(/revision.*exhausted/i);
    expect(() => handle.write(sample())).toThrow(/revision.*exhausted/i);
    expect(() => handle.write(result.record)).toThrow(/revision.*exhausted/i);
    expect(handle.read(id)).toEqual(result.record);
  });

  it('detects a plain writer between read and update', () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    store.writeRun({ ...before, cursor: 1 }, dir);
    expect(store.updateRunIf(id, before, increment, dir)).toEqual({ applied: false, reason: 'changed' });
    expect(store.readRun(id, dir).rev).toBe(before.rev + 1);
  });

  it('persists the mutation with exactly one revision increment', () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    const result = store.updateRunIf(id, before, increment, dir);
    expect(result.applied).toBe(true);
    expect(result.record).toEqual({ ...before, input: { counter: 1 }, rev: before.rev + 1 });
    expect(store.readRun(id, dir)).toEqual(result.record);
    expect(before.input.counter).toBe(0);
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  });

  it.each(['{partial', JSON.stringify({ id })])('refuses corrupt/partial records without overwriting: %s', (text) => {
    writeFileSync(store.runPath(id, dir), text);
    expect(store.updateRunIf(id, sample(), increment, dir)).toEqual({ applied: false, reason: 'unreadable' });
    expect(readFileSync(store.runPath(id, dir), 'utf8')).toBe(text);
  });

  it.each([
    ['null', null], ['negative', -1], ['fractional', 0.5], ['string', '0'],
    ['boolean', false], ['object', {}], ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects explicit %s revisions without overwriting', (_kind, rev) => {
    const text = JSON.stringify({ ...sample(), rev });
    writeFileSync(store.runPath(id, dir), text);
    let called = false;
    const result = store.updateRunIf(id, sample(), (r) => { called = true; return increment(r); }, dir);
    expect(result).toEqual({ applied: false, reason: 'unreadable' });
    expect(readFileSync(store.runPath(id, dir), 'utf8')).toBe(text);
    expect(called).toBe(false);
  });

  it.each([null, '', 7])('refuses malformed generation evidence without mutation: %s', (generation) => {
    const text = JSON.stringify({ ...sample(), rev: 1, generation });
    writeFileSync(store.runPath(id, dir), text);
    let called = false;
    expect(store.updateRunIf(id, sample(), r => { called = true; return increment(r); }, dir))
      .toEqual({ applied: false, reason: 'unreadable' });
    expect(called).toBe(false);
    expect(readFileSync(store.runPath(id, dir), 'utf8')).toBe(text);
  });

  it('treats a missing record as changed and never calls mutate', () => {
    expect(store.updateRunIf(id, sample(), () => { throw new Error('called'); }, dir))
      .toEqual({ applied: false, reason: 'changed' });
  });

  it('takes over a same-host lock only with affirmative dead-pid evidence', () => {
    store.writeRun(sample(), dir);
    writeFileSync(lockPath(), JSON.stringify(lock({ pid: 123456 })));
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, {
      isPidAlive: (pid) => { expect(pid).toBe(123456); return false; },
    }).applied).toBe(true);
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  });

  it.each(['live', 'foreign', 'garbage', 'incomplete', 'unknown'])('keeps a %s lock and bounds the wait', (kind) => {
    store.writeRun(sample(), dir);
    const text = kind === 'garbage' ? '{' : JSON.stringify(kind === 'incomplete' ? {} :
      lock(kind === 'foreign' ? { host: `${hostname()}-foreign` } : {}));
    writeFileSync(lockPath(), text);
    const start = Date.now();
    const opts = { waitMs: 100, pollMs: 10 };
    if (kind === 'unknown') opts.isPidAlive = () => { throw new Error('probe denied'); };
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, opts))
      .toEqual({ applied: false, reason: 'locked' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    expect(store.readRun(id, dir).input.counter).toBe(0);
  });

  it('refuses a lock replaced between stale inspection and rename', () => {
    store.writeRun(sample(), dir);
    writeFileSync(lockPath(), JSON.stringify(lock({ pid: 123456 })));
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, {
      isPidAlive: (pid) => {
        if (pid !== 123456) return true;
        writeFileSync(lockPath(), JSON.stringify(lock({ token: 'replacement' })));
        return false;
      },
    })).toEqual({ applied: false, reason: 'locked' });
    expect(store.readRun(id, dir).input.counter).toBe(0);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('replacement');
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock`]);
  });

  it('drops a mismatched claim without clobbering a third lock owner', async () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    writeFileSync(lockPath(), JSON.stringify(lock({ pid: 123456 })));
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const path = ${JSON.stringify(lockPath())};
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (from === path) fs.writeFileSync(path, ${JSON.stringify(JSON.stringify(lock({ token: 'third' })))});
      };
      syncBuiltinESMExports();
      const result = updateRunIf(${JSON.stringify(id)}, ${JSON.stringify(before)}, r => r,
        ${JSON.stringify(dir)}, { waitMs: 0, isPidAlive: () => {
          fs.writeFileSync(path, ${JSON.stringify(JSON.stringify(lock({ token: 'replacement' })))});
          return false;
        } });
      process.send(result, () => process.disconnect());
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const exited = once(child, 'exit');
    expect((await once(child, 'message'))[0]).toEqual({ applied: false, reason: 'locked' });
    await exited;
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('third');
    expect(store.readRun(id, dir)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock`]);
  });

  it('keeps mutation exclusive when a delayed stale reclaimer meets a replacement owner and third caller', async () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    writeFileSync(lockPath(), JSON.stringify(lock({ pid: 123456 })));
    const source = `
      import { readSync } from 'node:fs';
      import { updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const pause = (stage) => { process.send({ stage }); readSync(0, Buffer.alloc(1), 0, 1, null); };
      process.send({ stage: 'ready' });
      process.once('message', ({ dir, id, before, role }) => {
        const result = updateRunIf(id, before, r => {
          if (role === 'owner') pause('mutating');
          r.input.counter++;
          return r;
        }, dir, { waitMs: 100, isPidAlive: (pid) => {
          if (pid !== 123456) return true;
          if (role === 'reclaimer') pause('inspected');
          return false;
        } });
        process.send({ stage: 'result', result }, () => process.disconnect());
      });
    `;
    const children = [];
    async function start(role) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source],
        { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      await once(child, 'message');
      const next = once(child, 'message');
      child.send({ dir, id, before, role });
      return { child, message: (await next)[0] };
    }
    try {
      // B pauses after reading the dead lock. Without an acquisition guard, A can now replace it.
      const b = await start('reclaimer');
      expect(b.message.stage).toBe('inspected');
      const a = await start('owner');
      let bResult;
      if (a.message.stage === 'mutating') {
        const next = once(b.child, 'message');
        b.child.stdin.write('!'); // force B's rename while A is inside mutate
        bResult = (await next)[0].result;
      }
      const third = store.updateRunIf(id, before, increment, dir, { waitMs: 50 });
      let aResult = a.message.result;
      if (a.message.stage === 'mutating') {
        const next = once(a.child, 'message');
        a.child.stdin.write('!');
        aResult = (await next)[0].result;
      } else {
        const next = once(b.child, 'message');
        b.child.stdin.write('!');
        bResult = (await next)[0].result;
      }
      expect(third).toEqual({ applied: false, reason: 'locked' });
      expect([aResult, bResult].filter(r => r.applied)).toHaveLength(1);
      expect(store.readRun(id, dir)).toMatchObject({ rev: before.rev + 1, input: { counter: 1 } });
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }));
    }
  }, 10000);

  it('serializes delayed stale-guard reclaimers without exposing a live guard to a third caller', async () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    writeFileSync(`${lockPath()}.claim`, JSON.stringify(lock({ pid: 123456, token: 'dead-guard' })));
    writeFileSync(lockPath(), JSON.stringify(lock({ pid: 123457, token: 'dead-record' })));
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const pause = stage => { process.send({ stage }); fs.readSync(0, Buffer.alloc(1), 0, 1, null); };
      const rename = fs.renameSync;
      let role, guard;
      fs.renameSync = (from, to) => {
        rename(from, to);
        if (role === 'delayed' && from === guard) pause('renamed-guard');
      };
      syncBuiltinESMExports();
      process.send({ stage: 'ready' });
      process.once('message', args => {
        role = args.role;
        guard = args.dir + '/' + args.id + '.lock.claim';
        const result = updateRunIf(args.id, args.before, r => {
          r.input.counter++;
          return r;
        }, args.dir, { waitMs: 100, isPidAlive: pid => {
          if (pid === 123456) {
            if (role === 'delayed') pause('inspected-guard');
            return false;
          }
          if (pid === 123457) {
            if (role !== 'third') pause('inspected-record');
            return false;
          }
          return true;
        } });
        process.send({ stage: 'result', result }, () => process.disconnect());
      });
    `;
    const children = [];
    async function start(role) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source],
        { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      await once(child, 'message');
      const next = once(child, 'message');
      child.send({ role, dir, id, before });
      return { child, message: (await next)[0] };
    }
    async function release(entry) {
      const next = once(entry.child, 'message');
      entry.child.stdin.write('!');
      entry.message = (await next)[0];
    }
    try {
      const delayed = await start('delayed');
      expect(delayed.message.stage).toBe('inspected-guard');
      const owner = await start('owner');
      // The broken protocol lets owner replace the guard while delayed holds its old snapshot.
      await release(delayed);
      expect(delayed.message.stage).toBe('renamed-guard');
      const third = await start('third');
      expect(third.message).toEqual({ stage: 'result', result: { applied: false, reason: 'locked' } });
      await release(delayed);
      if (delayed.message.stage === 'inspected-record') await release(delayed);
      if (owner.message.stage === 'inspected-record') await release(owner);
      expect([delayed, owner, third].filter(entry => entry.message.result?.applied)).toHaveLength(1);
      expect(store.readRun(id, dir)).toMatchObject({ rev: before.rev + 1, input: { counter: 1 } });
      expect(readdirSync(dir)).toEqual([`${id}.json`]);
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }));
    }
  }, 10000);

  it('reclaims a same-host guard and choosing contender left by an exited child', async () => {
    store.writeRun(sample(), dir);
    const dead = spawn(process.execPath, ['-e', '']);
    await once(dead, 'exit');
    writeFileSync(`${lockPath()}.claim`, JSON.stringify(lock({ pid: dead.pid })));
    writeFileSync(`${lockPath()}.claim.waiter.fixture`, JSON.stringify(lock({ pid: dead.pid, ticket: 0 })));
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, { waitMs: 50 }).applied).toBe(true);
    expect(readdirSync(dir)).toEqual([`${id}.json`]);
  });

  it.each(['partial', 'foreign', 'unknown', 'exhausted'])('fails closed on %s admission evidence and cleans its own contender', kind => {
    store.writeRun(sample(), dir);
    const waiter = `${lockPath()}.claim.waiter.fixture`;
    const text = kind === 'partial' ? '{partial' : JSON.stringify(lock({
      ticket: kind === 'exhausted' ? Number.MAX_SAFE_INTEGER : 0,
      ...(kind === 'foreign' ? { host: `${hostname()}-foreign` } : {}),
    }));
    writeFileSync(waiter, text);
    const before = store.readRun(id, dir);
    const opts = { waitMs: 30 };
    if (kind === 'unknown') opts.isPidAlive = () => { throw new Error('denied'); };
    expect(store.updateRunIf(id, before, increment, dir, opts))
      .toEqual({ applied: false, reason: 'locked' });
    expect(() => store.writeRun(before, dir, opts)).toThrow(/lock.*timed out/i);
    expect(readFileSync(waiter, 'utf8')).toBe(text);
    expect(store.readRun(id, dir)).toEqual(before);
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock.claim.waiter.fixture`]);
  });

  it.each(['live', 'foreign', 'unknown', 'incomplete'])('keeps an unproven %s acquisition guard', kind => {
    store.writeRun(sample(), dir);
    const guard = `${lockPath()}.claim`;
    const text = JSON.stringify(kind === 'incomplete' ? {} :
      lock(kind === 'foreign' ? { host: `${hostname()}-foreign` } : {}));
    writeFileSync(guard, text);
    const opts = { waitMs: 30 };
    if (kind === 'unknown') opts.isPidAlive = () => { throw new Error('denied'); };
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, opts))
      .toEqual({ applied: false, reason: 'locked' });
    expect(readFileSync(guard, 'utf8')).toBe(text);
  });

  it('restores a live guard replaced during dead-owner inspection', () => {
    store.writeRun(sample(), dir);
    const guard = `${lockPath()}.claim`;
    writeFileSync(guard, JSON.stringify(lock({ pid: 123456 })));
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, {
      waitMs: 0, isPidAlive: () => {
        writeFileSync(guard, JSON.stringify(lock({ token: 'replacement' })));
        return false;
      },
    })).toEqual({ applied: false, reason: 'locked' });
    expect(JSON.parse(readFileSync(guard, 'utf8')).token).toBe('replacement');
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock.claim`]);
  });

  it('retains an abandoned acquisition guard and returns locked for operator inspection', () => {
    store.writeRun(sample(), dir);
    const guard = `${lockPath()}.claim`;
    writeFileSync(guard, '{partial');
    expect(store.updateRunIf(id, store.readRun(id, dir), increment, dir, { waitMs: 50 }))
      .toEqual({ applied: false, reason: 'locked' });
    expect(readFileSync(guard, 'utf8')).toBe('{partial');
    expect(store.readRun(id, dir).input.counter).toBe(0);
  });

  it('validates mutations, preserves id, and releases only its own lock on failure', () => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    expect(() => store.updateRunIf(id, before, (r) => ({ ...r, id: 'other' }), dir)).toThrow(/id/);
    expect(() => store.updateRunIf(id, before, () => ({ id }), dir)).toThrow(/invalid/);
    expect(() => store.updateRunIf(id, before, () => {
      writeFileSync(lockPath(), JSON.stringify(lock({ token: 'replacement' })));
      throw new Error('mutator failed');
    }, dir)).toThrow('mutator failed');
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('replacement');
    expect(store.readRun(id, dir)).toEqual(before);
  });

  it('allows exactly one of two real stale-lock takers to mutate in each of 20 rounds', async () => {
    // The exited process supplies an actual dead PID, exercising the default ESRCH probe.
    const dead = spawn(process.execPath, ['-e', '']);
    await once(dead, 'exit');
    store.writeRun(sample(), dir);
    for (let round = 0; round < 20; round++) {
      const before = store.readRun(id, dir);
      writeFileSync(lockPath(), JSON.stringify(lock({ pid: dead.pid, token: `dead-${round}` })));
      const results = await racers(2, { dir, id, expected: before });
      expect(results.filter((r) => r.applied)).toHaveLength(1);
      expect(results.filter((r) => !r.applied).map((r) => r.reason)[0]).toMatch(/^(changed|locked)$/);
      expect(store.readRun(id, dir).rev).toBe(before.rev + 1);
    }
  }, 60000);

  it('loses no increments from N real child processes retrying changed revisions', async () => {
    store.writeRun(sample(), dir);
    const start = store.readRun(id, dir).rev;
    const count = 8;
    const results = await racers(count, { dir, id, retry: true });
    expect(results.every((r) => r.applied)).toBe(true);
    expect(store.readRun(id, dir)).toMatchObject({ rev: start + count, input: { counter: count } });
  }, 30000);

  it('returned legacy CAS snapshot supports another CAS', () => {
    const before = sample();
    writeFileSync(store.runPath(id, dir), JSON.stringify(before));
    const first = store.updateRunIf(id, before, increment, dir);
    expect(first.applied).toBe(true);
    expect(first.record).toEqual(store.readRun(id, dir));
    const second = store.updateRunIf(id, first.record, increment, dir);
    expect(second.applied).toBe(true);
    expect(second.record).toMatchObject({ rev: 2, input: { counter: 2 } });
    expect(second.record).toEqual(store.readRun(id, dir));
  });

  it('reads legacy rev-less records as version zero, and ignores lock files in listings', () => {
    writeFileSync(store.runPath(id, dir), JSON.stringify(sample()));
    writeFileSync(join(dir, 'other.lock'), '{}');
    expect(store.readRun(id, dir)).toEqual(sample());
    expect(store.listRunIds(dir)).toEqual([id]);
    expect(store.updateRunIf(id, sample(), increment, dir).record.rev).toBe(1);
    store.writeRun(sample(), dir);
    expect(store.readRun(id, dir).rev).toBe(2);
    store.writeRun({ ...sample(), rev: 10 }, dir);
    expect(store.readRun(id, dir).rev).toBe(11);
  });

  it.each(['direct', 'handle'])('completed %s deletion cannot be undone by an earlier CAS', async kind => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    const source = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { createFileRunStore, deleteRun, updateRunIf } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'scripts/operations/run-store.mjs')).href)};
      const pause = stage => { process.send(stage); fs.readSync(0, Buffer.alloc(1), 0, 1, null); };
      process.send('ready');
      process.once('message', ({ dir, id, before, role, kind }) => {
        if (role === 'cas') {
          const result = updateRunIf(id, before, r => {
            pause('mutating');
            r.input.counter++;
            return r;
          }, dir);
          process.send(result, () => process.disconnect());
        } else {
          const open = fs.openSync;
          let paused = false;
          fs.openSync = (path, ...args) => {
            try { return open(path, ...args); }
            catch (error) {
              if (!paused && path === dir + '/' + id + '.lock' && error.code === 'EEXIST') {
                paused = true;
                pause('blocked');
              }
              throw error;
            }
          };
          syncBuiltinESMExports();
          if (kind === 'direct') deleteRun(id, dir);
          else createFileRunStore(dir).delete(id);
          process.send('deleted', () => process.disconnect());
        }
      });
    `;
    const children = [];
    async function start(role) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source],
        { stdio: ['pipe', 'ignore', 'inherit', 'ipc'] });
      children.push(child);
      expect((await once(child, 'message'))[0]).toBe('ready');
      const next = once(child, 'message');
      child.send({ role, kind, dir, id, before });
      return { child, message: (await next)[0] };
    }
    try {
      const cas = await start('cas');
      expect(cas.message).toBe('mutating');
      const deletion = await start('delete');
      const result = once(cas.child, 'message');
      cas.child.stdin.write('!');
      expect((await result)[0].applied).toBe(true);
      if (deletion.message === 'blocked') {
        const deleted = once(deletion.child, 'message');
        deletion.child.stdin.write('!');
        expect((await deleted)[0]).toBe('deleted');
      } else expect(deletion.message).toBe('deleted');
      expect(store.tryReadRun(id, dir)).toBeNull();
      expect(deletion.message).toBe('blocked');
      expect(store.updateRunIf(id, before, increment, dir)).toEqual({ applied: false, reason: 'changed' });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }));
    }
  });

  it.each(['direct', 'handle'])('%s deletion fails closed when the record lock wait expires', kind => {
    store.writeRun(sample(), dir);
    const before = store.readRun(id, dir);
    const text = JSON.stringify(lock());
    writeFileSync(lockPath(), text);
    const remove = () => kind === 'direct' ? store.deleteRun(id, dir, { waitMs: 30 }) :
      store.createFileRunStore(dir).delete(id, { waitMs: 30 });
    expect(remove).toThrow(/lock.*timed out/i);
    expect(store.readRun(id, dir)).toEqual(before);
    expect(readFileSync(lockPath(), 'utf8')).toBe(text);
    expect(readdirSync(dir).sort()).toEqual([`${id}.json`, `${id}.lock`]);
  });

  it.each(['file', 'memory'])('rejects snapshots from a deleted and recreated run (%s)', (kind) => {
    const handle = kind === 'file' ? store.createFileRunStore(dir) : store.createMemoryRunStore();
    const snapshot = handle.write(sample());
    handle.delete(id);
    const replacement = handle.write({ ...sample(), input: { counter: 42 } });
    let called = false;
    expect(handle.updateIf(id, snapshot, r => { called = true; return increment(r); }))
      .toEqual({ applied: false, reason: 'changed' });
    expect(called).toBe(false);
    expect(handle.read(id)).toEqual(replacement);
    expect(replacement.generation).not.toBe(snapshot.generation);
    handle.delete(id);
    const restored = handle.write(snapshot);
    expect(restored.generation).not.toBe(snapshot.generation);
  });

  it.each(['file', 'memory'])('returns the persisted snapshot from write for immediate CAS on the %s handle', (kind) => {
    const handle = kind === 'file' ? store.createFileRunStore(dir) : store.createMemoryRunStore();
    const original = sample();
    const written = handle.write(original);
    expect(written).toEqual({ ...original, rev: 1, generation: expect.any(String) });
    expect(written).toEqual(handle.read(id));
    expect(original).not.toHaveProperty('rev');
    expect(handle.updateIf(id, written, increment)).toEqual({
      applied: true, record: { ...written, input: { counter: 1 }, rev: 2 },
    });
  });

  it.each(['file', 'memory'])('exposes updateIf with matching revision semantics on the %s handle', (kind) => {
    const handle = kind === 'file' ? store.createFileRunStore(dir) : store.createMemoryRunStore();
    handle.write(sample());
    const before = handle.read(id);
    expect(before.rev).toBe(1);
    expect(handle.updateIf(id, before, increment).record.rev).toBe(2);
    expect(handle.updateIf(id, before, increment)).toEqual({ applied: false, reason: 'changed' });
    handle.write(sample());
    expect(handle.read(id).rev).toBe(3);
    handle.write({ ...sample(), rev: 10 });
    expect(handle.read(id).rev).toBe(11);
    handle.delete(id);
    expect(handle.updateIf(id, before, increment)).toEqual({ applied: false, reason: 'changed' });
  });
});
