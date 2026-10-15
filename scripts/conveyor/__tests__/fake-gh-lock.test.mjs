// @vitest-environment node
// Child processes import the helper by file URL, so this suite needs the Node environment.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStoreLock, releaseStoreLock, withStore, LOCK_STALE_MS } from './helpers/fake-gh.mjs';

const helper = new URL('./helpers/fake-gh.mjs', import.meta.url).href;
const realNowMs = () => performance.timeOrigin + performance.now();
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fake-gh-lock-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'store.json');
}
function backdate(path) {
  const past = new Date(realNowMs() - LOCK_STALE_MS - 5_000);
  utimesSync(path, past, past);
}
function holderPath(lock) { return join(lock, readdirSync(lock)[0]); }
function holder(lock) { return JSON.parse(readFileSync(holderPath(lock), 'utf8')); }
// Use a reaped process's PID when modelling a crashed holder; an aged live PID still owns its lock.
function deadPid() {
  return Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
}

// Signal readiness before entering the synchronous acquire, so assertions never depend on child boot time.
async function waiter(store, futureClock = false) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireStoreLock, releaseStoreLock } from ${JSON.stringify(helper)};
    ${futureClock ? 'Date.now = () => 9_000_000_000_000;' : ''}
    process.send('ready');
    process.on('message', () => {
      const lock = acquireStoreLock(${JSON.stringify(store)});
      process.send('acquired');
      releaseStoreLock(lock);
      process.disconnect();
    });
  `], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  cleanups.push(() => child.kill('SIGKILL'));
  let acquired = false;
  const ready = new Promise((resolve) => child.once('message', resolve));
  const done = new Promise((resolve, reject) => {
    child.on('message', (message) => { if (message === 'acquired') acquired = true; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`lock waiter exited ${code}`)));
  });
  await ready;
  child.send('go');
  return { done, acquired: () => acquired };
}

describe('fake-gh store lock recovery', () => {
  it('keeps an expired live writer exclusive until its store update finishes', () => {
    const store = fixture();
    writeFileSync(store, JSON.stringify({ count: 0 }));
    let contender;
    let preserved;
    withStore(store, (state) => {
      const lock = `${store}.lock`;
      const original = { ...holder(lock), at: realNowMs() - 60_000 };
      writeFileSync(holderPath(lock), JSON.stringify(original));
      contender = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { withStore } from ${JSON.stringify(helper)};
        // Stop at the first contention backoff instead of waiting for the 20 s deadline.
        Atomics.wait = () => { throw new Error('live holder'); };
        try {
          withStore(${JSON.stringify(store)}, (state) => { state.count += 10; });
          process.stdout.write('acquired');
        } catch (err) {
          if (err.message !== 'live holder') throw err;
          process.stdout.write('blocked');
        }
      `], { encoding: 'utf8', timeout: 5_000 });
      preserved = existsSync(lock) && holder(lock).token === original.token;
      // This paused writer would clobber the contender's update if its lease were stolen.
      state.count += 1;
    });
    expect(contender).toBe('blocked');
    expect(preserved).toBe(true);
    expect(JSON.parse(readFileSync(store, 'utf8')).count).toBe(1);
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  const races = ['release', 'takeover', 'empty', 'malformed'].flatMap((operation) =>
    ['entry', 'directory'].map((boundary) => [operation, boundary]));
  races.push(['missing', 'directory']);
  it.each(races)('%s preserves a replacement arriving before retiring the %s', (operation, boundary) => {
    const store = fixture();
    // Intercept the filesystem boundary in a real Node process. A second process acquires the
    // replacement after another retiree removes the old lock, before the paused operation resumes.
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { acquireStoreLock, releaseStoreLock } from ${JSON.stringify(helper)};
      const store = ${JSON.stringify(store)};
      const lock = acquireStoreLock(store);
      const entry = fs.readdirSync(lock)[0];
      const original = JSON.parse(fs.readFileSync(join(lock, entry), 'utf8'));
      if (${JSON.stringify(operation)} === 'takeover') {
        const pid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']));
        fs.writeFileSync(join(lock, entry), JSON.stringify({ ...original, pid, at: 0 }));
      }
      if (['missing', 'empty', 'malformed'].includes(${JSON.stringify(operation)})) {
        fs.unlinkSync(join(lock, entry));
        if (${JSON.stringify(operation)} !== 'missing') {
          fs.writeFileSync(join(lock, 'holder.json'), ${JSON.stringify(operation)} === 'empty' ? '' : '{');
        }
        fs.utimesSync(lock, new Date(0), new Date(0));
      }
      const saved = { renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, rmdirSync: fs.rmdirSync };
      let replacement;
      let injecting = false;
      function replace() {
        if (replacement || injecting) return;
        injecting = true;
        fs.rmSync(lock, { recursive: true });
        execFileSync(process.execPath, ['--input-type=module', '-e',
          'import { acquireStoreLock } from ' + ${JSON.stringify(JSON.stringify(helper))} +
          '; acquireStoreLock(' + JSON.stringify(store) + ');'
        ], { timeout: 5_000 });
        const name = fs.readdirSync(lock)[0];
        replacement = { name, body: fs.readFileSync(join(lock, name), 'utf8') };
        injecting = false;
      }
      fs.renameSync = (from, to) => { if (from === lock) replace(); return saved.renameSync(from, to); };
      fs.unlinkSync = (path) => {
        if (${JSON.stringify(boundary)} === 'entry' && path.startsWith(lock + '/')) replace();
        return saved.unlinkSync(path);
      };
      fs.rmdirSync = (path, options) => {
        if (${JSON.stringify(boundary)} === 'directory' && path === lock) replace();
        return saved.rmdirSync(path, options);
      };
      syncBuiltinESMExports();
      const wait = Atomics.wait;
      Atomics.wait = () => { throw new Error('replacement is still held'); };
      let outcome = 'released';
      try {
        if (${JSON.stringify(operation)} === 'release') releaseStoreLock(lock);
        else { acquireStoreLock(store); outcome = 'acquired'; }
      } catch (err) {
        if (err.message !== 'replacement is still held') throw err;
        outcome = 'blocked';
      } finally {
        Object.assign(fs, saved);
        syncBuiltinESMExports();
        Atomics.wait = wait;
      }
      const preserved = replacement && fs.existsSync(join(lock, replacement.name)) &&
        fs.readFileSync(join(lock, replacement.name), 'utf8') === replacement.body;
      process.stdout.write(JSON.stringify({ injected: !!replacement, preserved: !!preserved, outcome }));
    `], { encoding: 'utf8', timeout: 10_000 }));
    expect(result.injected).toBe(true);
    expect(result.preserved).toBe(true);
    expect(result.outcome).toBe(operation === 'release' ? 'released' : 'blocked');
  });

  it.each(['missing', 'empty', 'malformed'])('promptly recovers a stale %s holder', (kind) => {
    const store = fixture();
    const lock = `${store}.lock`;
    mkdirSync(lock);
    if (kind !== 'missing') writeFileSync(join(lock, 'holder.json'), kind === 'empty' ? '' : '{');
    backdate(lock);
    const started = realNowMs();
    expect(acquireStoreLock(store)).toBe(lock);
    expect(realNowMs() - started).toBeLessThan(2_000);
    expect(holder(lock).token).toBeTruthy();
    releaseStoreLock(lock);
    expect(existsSync(lock)).toBe(false);
  });

  it('recovers two crashed holders left in one directory but keeps a live one', () => {
    const store = fixture();
    const lock = `${store}.lock`;
    mkdirSync(lock);
    const dead = (n) => JSON.stringify({ pid: deadPid(), at: realNowMs() - 60_000, token: `dead-${n}` });
    writeFileSync(join(lock, 'holder-00000000-0000-0000-0000-000000000001.json'), dead(1));
    writeFileSync(join(lock, 'holder-00000000-0000-0000-0000-000000000002.json'), dead(2));
    const started = realNowMs();
    expect(acquireStoreLock(store)).toBe(lock);
    expect(realNowMs() - started).toBeLessThan(2_000);
    expect(readdirSync(lock)).toHaveLength(1);
    releaseStoreLock(lock);

    mkdirSync(lock);
    const live = JSON.stringify({ pid: process.pid, at: realNowMs() - 60_000, token: 'live' });
    writeFileSync(join(lock, 'holder-00000000-0000-0000-0000-000000000003.json'), dead(3));
    writeFileSync(join(lock, 'holder-00000000-0000-0000-0000-000000000004.json'), live);
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireStoreLock } from ${JSON.stringify(helper)};
      let waits = 0;
      Atomics.wait = () => { if (++waits > 3) throw new Error('live holder'); return 'timed-out'; };
      try { acquireStoreLock(${JSON.stringify(store)}); process.stdout.write('acquired'); } catch (err) {
        if (err.message !== 'live holder') throw err;
        process.stdout.write('blocked');
      }
    `], { encoding: 'utf8', timeout: 5_000 });
    expect(result).toBe('blocked');
    expect(readdirSync(lock)).toEqual(['holder-00000000-0000-0000-0000-000000000004.json']);
  });

  it('waits for a fresh orphan instead of replacing the empty directory', async () => {
    const store = fixture();
    const lock = `${store}.lock`;
    mkdirSync(lock);
    const waiting = await waiter(store);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(waiting.acquired()).toBe(false);
    expect(existsSync(join(lock, 'holder.json'))).toBe(false);
    rmSync(lock, { recursive: true });
    await waiting.done;
    expect(waiting.acquired()).toBe(true);
  }, 5_000);

  it('never replaces a lock directory created between the acquire check and publish', () => {
    const store = fixture();
    // Pause the acquirer right after it saw no lock, create a fresh empty lock there, then resume.
    // Hook both publish shapes (rename onto the lock, or exclusive mkdir of it).
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { acquireStoreLock } from ${JSON.stringify(helper)};
      const lock = ${JSON.stringify(`${store}.lock`)};
      const saved = { renameSync: fs.renameSync, mkdirSync: fs.mkdirSync };
      let injected = false;
      function inject() { if (!injected) { injected = true; saved.mkdirSync(lock); } }
      fs.renameSync = (from, to) => { if (to === lock) inject(); return saved.renameSync(from, to); };
      fs.mkdirSync = (path, options) => { if (path === lock) inject(); return saved.mkdirSync(path, options); };
      syncBuiltinESMExports();
      const wait = Atomics.wait;
      Atomics.wait = () => { throw new Error('replacement is still held'); };
      let outcome = 'acquired';
      try { acquireStoreLock(${JSON.stringify(store)}); } catch (err) {
        if (err.message !== 'replacement is still held') throw err;
        outcome = 'blocked';
      } finally {
        Object.assign(fs, saved);
        syncBuiltinESMExports();
        Atomics.wait = wait;
      }
      process.stdout.write(JSON.stringify({ injected, outcome, entries: fs.readdirSync(lock) }));
    `], { encoding: 'utf8', timeout: 10_000 }));
    expect(result.injected).toBe(true);
    expect(result.outcome).toBe('blocked');
    expect(result.entries).toEqual([]);
  });

  it('withdraws from a replacement owner after its own empty lock was retired mid-publish', () => {
    const store = fixture();
    // Pause the publisher after its mkdir: retire its empty directory as a stale takeover would,
    // let another process acquire, then resume the publisher's move into the shared path.
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { execFileSync } from 'node:child_process';
      import { acquireStoreLock } from ${JSON.stringify(helper)};
      const lock = ${JSON.stringify(`${store}.lock`)};
      const saved = { renameSync: fs.renameSync };
      let replacement;
      fs.renameSync = (from, to) => {
        if (!replacement && to.startsWith(lock + '/')) {
          fs.rmdirSync(lock);
          execFileSync(process.execPath, ['--input-type=module', '-e',
            'import { acquireStoreLock } from ' + ${JSON.stringify(JSON.stringify(helper))} +
            '; acquireStoreLock(' + JSON.stringify(${JSON.stringify(store)}) + ');'
          ], { timeout: 5_000 });
          replacement = fs.readdirSync(lock)[0];
        }
        return saved.renameSync(from, to);
      };
      syncBuiltinESMExports();
      const wait = Atomics.wait;
      Atomics.wait = () => { throw new Error('replacement is still held'); };
      let outcome = 'acquired';
      try { acquireStoreLock(${JSON.stringify(store)}); } catch (err) {
        if (err.message !== 'replacement is still held') throw err;
        outcome = 'blocked';
      } finally {
        Object.assign(fs, saved);
        syncBuiltinESMExports();
        Atomics.wait = wait;
      }
      process.stdout.write(JSON.stringify({ replacement, outcome, entries: fs.readdirSync(lock) }));
    `], { encoding: 'utf8', timeout: 10_000 }));
    expect(result.replacement).toMatch(/^holder-/);
    expect(result.outcome).toBe('blocked');
    expect(result.entries).toEqual([result.replacement]);
  });

  it('does not release a replacement acquired by another process after stale takeover', () => {
    const store = fixture();
    const lock = acquireStoreLock(store);
    const original = holder(lock);
    writeFileSync(holderPath(lock), JSON.stringify({ ...original, pid: deadPid(), at: realNowMs() - 60_000 }));
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireStoreLock } from ${JSON.stringify(helper)};
      acquireStoreLock(${JSON.stringify(store)});
    `], { timeout: 5_000 });
    const replacement = holder(lock);
    expect(replacement.token).not.toBe(original.token);
    releaseStoreLock(lock);
    expect(holder(lock)).toEqual(replacement);
  });

  it('ignores a future simulator Date.now when waiting for a fresh live holder', async () => {
    const store = fixture();
    const lock = acquireStoreLock(store);
    const original = holder(lock);
    const waiting = await waiter(store, true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(waiting.acquired()).toBe(false);
    expect(holder(lock)).toEqual(original);
    releaseStoreLock(lock);
    await waiting.done;
    expect(waiting.acquired()).toBe(true);
  }, 5_000);

  it('sweeps old temporary and retired siblings while preserving fresh siblings', () => {
    const store = fixture();
    for (const kind of ['tmp', 'dead']) {
      mkdirSync(`${store}.lock.${kind}-old`);
      backdate(`${store}.lock.${kind}-old`);
      mkdirSync(`${store}.lock.${kind}-fresh`);
    }
    const lock = acquireStoreLock(store);
    for (const kind of ['tmp', 'dead']) {
      expect(existsSync(`${store}.lock.${kind}-old`)).toBe(false);
      expect(existsSync(`${store}.lock.${kind}-fresh`)).toBe(true);
    }
    releaseStoreLock(lock);
  });

  it('preserves an old candidate while its publisher is still alive', () => {
    const store = fixture();
    const candidate = `${store}.lock.tmp-${process.pid}-paused`;
    mkdirSync(candidate);
    writeFileSync(join(candidate, 'holder-paused.json'), 'complete record');
    backdate(candidate);
    const lock = acquireStoreLock(store);
    expect(readFileSync(join(candidate, 'holder-paused.json'), 'utf8')).toBe('complete record');
    releaseStoreLock(lock);
  });

  it('serializes concurrent processes updating the shared store', async () => {
    const store = fixture();
    writeFileSync(store, JSON.stringify({ count: 0 }));
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', `
        import { withStore, sleepSyncMs } from ${JSON.stringify(helper)};
        for (let i = 0; i < 5; i++) {
          withStore(${JSON.stringify(store)}, (state) => {
            const count = state.count;
            sleepSyncMs(5);
            state.count = count + 1;
          });
        }
      `], { stdio: ['ignore', 'ignore', 'pipe'] });
      cleanups.push(() => child.kill('SIGKILL'));
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`)));
    })));
    expect(JSON.parse(readFileSync(store, 'utf8')).count).toBe(30);
    expect(existsSync(`${store}.lock`)).toBe(false);
  }, 10_000);
});
