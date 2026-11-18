import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireBuildQueueLock, buildQueueCacheKey, readBuildQueueCache, waitForBuildQueueCache, writeBuildQueueCache } from '../build-queue-cache.mjs';
const dirs = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cache-test-')); dirs.push(dir);
  const backlogDir = join(dir, 'backlog'); mkdirSync(backlogDir);
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, '{}');
  writeFileSync(join(backlogDir, 'a.md'), 'a');
  return { dir, backlogDir, configPath };
}
afterEach(() => {
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
it('invalidates on markdown mtime, added file, config mtime and next flag', () => {
  const o = setup(); let key = buildQueueCacheKey(o);
  utimesSync(join(o.backlogDir, 'a.md'), 2000000000, 2000000000);
  expect(buildQueueCacheKey(o)).not.toBe(key); key = buildQueueCacheKey(o);
  writeFileSync(join(o.backlogDir, 'b.md'), 'b');
  expect(buildQueueCacheKey(o)).not.toBe(key); key = buildQueueCacheKey(o);
  utimesSync(o.configPath, 2000000000, 2000000000);
  expect(buildQueueCacheKey(o)).not.toBe(key); key = buildQueueCacheKey(o);
  expect(buildQueueCacheKey({ ...o, next: true })).not.toBe(key);
});
it('invalidates on a same-mtime size change', () => {
  const o = setup(); const f = join(o.backlogDir, 'a.md'); const key = buildQueueCacheKey(o);
  const m = statSync(f).mtime; writeFileSync(f, 'aaaa'); utimesSync(f, m, m);
  expect(buildQueueCacheKey(o)).not.toBe(key);
});
it('returns exact stdout only for a matching, unexpired key', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeBuildQueueCache({ file, key: 'key', at: 100, stdout: '{"ok":true}\n' });
  expect(readBuildQueueCache({ file, key: 'key', now: 119, maxAgeMs: 20 })).toBe('{"ok":true}\n');
  expect(readBuildQueueCache({ file, key: 'key', now: 120, maxAgeMs: 20 })).toBeNull();
  expect(readBuildQueueCache({ file, key: 'other', now: 110, maxAgeMs: 20 })).toBeNull();
  expect(readBuildQueueCache({ file, key: 'key', now: 99, maxAgeMs: 20 })).toBeNull();
  expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('denies a second caller the held lock and serves the first caller stdout after write and release', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const key = 'shared-key'; const stdout = '{"builds":[1]}\n';
  expect(readBuildQueueCache({ file, key })).toBeNull();
  const release = acquireBuildQueueLock({ file });
  expect(release).toBeTypeOf('function');
  expect(release.holds()).toBe(true);
  expect(statSync(`${file}.lock`).isDirectory()).toBe(true);
  try {
    expect(readBuildQueueCache({ file, key })).toBeNull();
    expect(acquireBuildQueueLock({ file })).toBeNull();
    writeBuildQueueCache({ file, key, stdout, fence: release.holds });
  } finally { release(); }
  expect(release.holds()).toBe(false);
  expect(waitForBuildQueueCache({ file, key, timeoutMs: 25, pollMs: 5 })).toBe(stdout);
});

it('a late caller without the lock prints its result without publishing a cache file', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  const stdout = '{"builds":[1]}\n';
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { acquireBuildQueueLock, writeBuildQueueCache }
        from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/build-queue-cache.mjs')).href)};
      const file = ${JSON.stringify(file)};
      const releaseLock = acquireBuildQueueLock({ file });
      if (releaseLock !== null) throw new Error('expected lock contention');
      const stdout = ${JSON.stringify(stdout)};
      writeBuildQueueCache({ file, key: 'key', stdout, fence: releaseLock ? releaseLock.holds : () => false });
      process.stdout.write(stdout);
    `], { encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe(stdout);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
  } finally { release(); }
});

it.each(['false', 'throws'])('checks the fence after staging and preserves existing cache when it %s', outcome => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeBuildQueueCache({ file, key: 'key', stdout: 'existing\n' });
  let calls = 0;
  let staged;
  writeBuildQueueCache({ file, key: 'key', stdout: 'late\n', fence: () => {
    calls++;
    const temp = readdirSync(dir).find(name => name.endsWith('.tmp'));
    staged = temp && JSON.parse(fs.readFileSync(join(dir, temp), 'utf8')).stdout;
    if (outcome === 'throws') throw new Error('unreadable ownership');
    return false;
  } });
  expect(calls).toBe(1);
  expect(staged).toBe('late\n');
  expect(readBuildQueueCache({ file, key: 'key' })).toBe('existing\n');
  expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('drops a reclaimed owner late publish while the replacement owner publishes', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const releaseA = acquireBuildQueueLock({ file, now: 1_000, staleMs: 100 });
  expect(releaseA.holds()).toBe(true);
  const releaseB = acquireBuildQueueLock({ file, now: 1_101, staleMs: 100 });
  try {
    expect(releaseA.holds()).toBe(false);
    expect(releaseB.holds()).toBe(true);
    writeBuildQueueCache({ file, key: 'key', stdout: 'A\n', fence: releaseA.holds });
    expect(existsSync(file)).toBe(false);
    writeBuildQueueCache({ file, key: 'key', stdout: 'B\n', fence: releaseB.holds });
    expect(readBuildQueueCache({ file, key: 'key' })).toBe('B\n');
    writeBuildQueueCache({ file, key: 'key', stdout: 'A late\n', fence: releaseA.holds });
    expect(readBuildQueueCache({ file, key: 'key' })).toBe('B\n');
    expect(readdirSync(dir).some(name => name.endsWith('.tmp'))).toBe(false);
  } finally { releaseA(); releaseB(); }
});

it('holds fails closed on owner read errors and missing owner files', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  let unreadable = false;
  const release = acquireBuildQueueLock({ file, io: { ...fs, readFileSync(...args) {
    if (unreadable) throw new Error('denied');
    return fs.readFileSync(...args);
  } } });
  expect(release.holds()).toBe(true);
  unreadable = true;
  expect(release.holds()).toBe(false);
  unreadable = false;
  rmSync(`${file}.lock/owner.json`);
  expect(release.holds()).toBe(false);
  release();
});

it('holds stays false after release even if release cannot acquire its guard', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  mkdirSync(`${file}.lock.guard`);
  release();
  expect(existsSync(`${file}.lock/owner.json`)).toBe(true);
  expect(release.holds()).toBe(false);
});

it('waits until timeout and returns null for a different content key', () => {
  const o = setup(); const file = join(o.dir, 'cache.json');
  const key = buildQueueCacheKey(o);
  writeBuildQueueCache({ file, key, stdout: 'old content\n' });
  writeFileSync(join(o.backlogDir, 'b.md'), 'new content');
  const changedKey = buildQueueCacheKey(o);
  expect(changedKey).not.toBe(key);
  const started = Date.now();
  expect(waitForBuildQueueCache({ file, key: changedKey, timeoutMs: 25, pollMs: 5 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
});

it('expires cached stdout at the default 300 second TTL', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeBuildQueueCache({ file, key: 'key', at: 1_000, stdout: 'expired\n' });
  expect(readBuildQueueCache({ file, key: 'key', now: 300_999 })).toBe('expired\n');
  expect(readBuildQueueCache({ file, key: 'key', now: 301_000 })).toBeNull();
});

it('fails open on a corrupt cache file with null from read and timed-out wait', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeFileSync(file, '{invalid json');
  expect(readBuildQueueCache({ file, key: 'key' })).toBeNull();
  const started = Date.now();
  expect(waitForBuildQueueCache({ file, key: 'key', timeoutMs: 25, pollMs: 5 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
});

it('keeps a live owner at 120 seconds and reclaims it past the default 10 minute hard cap', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  expect(acquireBuildQueueLock({ file, now: 1_000, pid: process.pid })).toBeTypeOf('function');
  const owner = fs.readFileSync(`${file}.lock/owner.json`, 'utf8');
  expect(acquireBuildQueueLock({ file, now: 121_000 })).toBeNull();
  expect(acquireBuildQueueLock({ file, now: 600_999 })).toBeNull();
  expect(fs.readFileSync(`${file}.lock/owner.json`, 'utf8')).toBe(owner);
  const release = acquireBuildQueueLock({ file, now: 701_000 });
  expect(release).toBeTypeOf('function');
  try {
    expect(acquireBuildQueueLock({ file, now: 701_001 })).toBeNull();
  } finally { release(); }
});

it('reclaims a fresh lock whose recorded pid is dead', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const now = Date.now();
  expect(acquireBuildQueueLock({ file, now, pid: 2147483646 })).toBeTypeOf('function');
  const release = acquireBuildQueueLock({ file, now: now + 1 });
  expect(release).toBeTypeOf('function');
  try {
    expect(acquireBuildQueueLock({ file, now: now + 2 })).toBeNull();
  } finally { release(); }
});

it('removes the lock on release and allows another caller to acquire it', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  expect(release).toBeTypeOf('function');
  expect(existsSync(`${file}.lock`)).toBe(true);
  release();
  expect(existsSync(`${file}.lock`)).toBe(false);
  const nextRelease = acquireBuildQueueLock({ file });
  expect(nextRelease).toBeTypeOf('function');
  nextRelease();
});

it('returns null for live-owner contention without changing lock ownership', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  const owner = fs.readFileSync(`${file}.lock/owner.json`, 'utf8');
  expect(acquireBuildQueueLock({ file })).toBeNull();
  expect(fs.readFileSync(`${file}.lock/owner.json`, 'utf8')).toBe(owner);
  release();
});

it('returns null without leaving a lock on filesystem acquisition errors', () => {
  const { dir } = setup(); const parent = join(dir, 'not-a-directory');
  writeFileSync(parent, 'unchanged');
  const file = join(parent, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  expect(release).toBeNull();
  expect(fs.readFileSync(parent, 'utf8')).toBe('unchanged');
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(existsSync(`${file}.lock.guard`)).toBe(false);
});

it('returns null and cleans up when writing the lock owner fails', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  let attempted = false;
  const release = acquireBuildQueueLock({ file, io: { ...fs, writeFileSync(path, ...args) {
    if (path === `${file}.lock/owner.json`) {
      attempted = true;
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    }
    return fs.writeFileSync(path, ...args);
  } } });
  expect(release).toBeNull();
  expect(attempted).toBe(true);
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(existsSync(`${file}.lock.guard`)).toBe(false);
});

it.each([undefined, '{invalid', 'null', '{}',
  JSON.stringify({ pid: process.pid, at: 'old', token: 'owner' }),
  JSON.stringify({ pid: 0, at: 0, token: 'owner' }),
  JSON.stringify({ pid: process.pid, at: 0 }),
])('returns null and preserves existing ownership for missing or malformed owner data: %s', content => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  mkdirSync(`${file}.lock`);
  const ownerFile = `${file}.lock/owner.json`;
  if (content !== undefined) writeFileSync(ownerFile, content);
  expect(acquireBuildQueueLock({ file })).toBeNull();
  expect(existsSync(`${file}.lock`)).toBe(true);
  expect(existsSync(`${file}.lock.guard`)).toBe(false);
  if (content === undefined) expect(existsSync(ownerFile)).toBe(false);
  else expect(fs.readFileSync(ownerFile, 'utf8')).toBe(content);
});

it('returns null on an owner read error without changing the existing lock', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const release = acquireBuildQueueLock({ file });
  const owner = fs.readFileSync(`${file}.lock/owner.json`, 'utf8');
  expect(acquireBuildQueueLock({ file, io: { ...fs, readFileSync() {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  } } })).toBeNull();
  expect(fs.readFileSync(`${file}.lock/owner.json`, 'utf8')).toBe(owner);
  expect(existsSync(`${file}.lock.guard`)).toBe(false);
  release();
});

it('returns null on guard contention without creating a lock or removing the other guard', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  mkdirSync(`${file}.lock.guard`);
  expect(acquireBuildQueueLock({ file })).toBeNull();
  expect(existsSync(`${file}.lock`)).toBe(false);
  expect(existsSync(`${file}.lock.guard`)).toBe(true);
});

it('serializes concurrent stale-lock recovery before a second contender can inspect the old owner', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const oldRelease = acquireBuildQueueLock({ file, now: 1_000, staleMs: 100 });
  let contender;
  let inspections = 0;
  const io = { ...fs, readFileSync(path, ...args) {
    const content = fs.readFileSync(path, ...args);
    if (path === `${file}.lock/owner.json` && ++inspections === 1) {
      // Pause recovery after reading the old owner, before removing its directory.
      contender = acquireBuildQueueLock({ file, now: 1_101, staleMs: 100, io });
    }
    return content;
  } };
  const release = acquireBuildQueueLock({ file, now: 1_101, staleMs: 100, io });
  expect(release).toBeTypeOf('function');
  expect(contender).toBeNull();
  expect(inspections).toBe(1);
  expect(acquireBuildQueueLock({ file, now: 1_102, staleMs: 100 })).toBeNull();
  oldRelease();
  release();
  expect(existsSync(`${file}.lock`)).toBe(false);
});

it('an old owner release cannot remove a replacement owner lock', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const oldRelease = acquireBuildQueueLock({ file, now: 1_000, staleMs: 100 });
  const release = acquireBuildQueueLock({ file, now: 1_101, staleMs: 100 });
  const owner = fs.readFileSync(`${file}.lock/owner.json`, 'utf8');
  oldRelease();
  expect(fs.readFileSync(`${file}.lock/owner.json`, 'utf8')).toBe(owner);
  expect(acquireBuildQueueLock({ file, now: 1_102, staleMs: 100 })).toBeNull();
  release();
  release();
  expect(existsSync(`${file}.lock`)).toBe(false);
});

it('single-flights real concurrent child processes so both print cached stdout after exactly one compute', async () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  const counter = join(dir, 'computes.txt');
  const stdout = '{"builds":[1]}\n';
  const script = `
    import { once } from 'node:events';
    import { appendFileSync } from 'node:fs';
    import { acquireBuildQueueLock, readBuildQueueCache, waitForBuildQueueCache, writeBuildQueueCache }
      from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/build-queue-cache.mjs')).href)};
    const file = ${JSON.stringify(file)};
    const key = 'shared-key';
    const initial = readBuildQueueCache({ file, key });
    // Both children must observe a miss before either starts acquisition.
    const start = once(process, 'message');
    process.send({ initial });
    await start;
    process.disconnect();
    if (initial !== null) { process.stdout.write(initial); process.exit(0); }
    const deadline = Date.now() + 5_000;
    for (;;) {
      const release = acquireBuildQueueLock({ file });
      if (release) {
        try {
          let fresh = readBuildQueueCache({ file, key });
          if (fresh === null) {
            appendFileSync(${JSON.stringify(counter)}, 'compute\\n');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
            fresh = ${JSON.stringify(stdout)};
            writeBuildQueueCache({ file, key, stdout: fresh, fence: release.holds });
          }
          process.stdout.write(fresh);
        } finally { release(); }
        break;
      }
      const cached = waitForBuildQueueCache({ file, key, timeoutMs: 100 });
      if (cached !== null) { process.stdout.write(cached); break; }
      if (Date.now() >= deadline) throw new Error('single-flight wait timed out');
    }
  `;
  function startChild() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = ''; let errors = ''; let bytes = 0;
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('close', (code, signal) => reject(new Error('child exited before ready: ' + code + ' ' + signal + ' ' + errors)));
    });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('child timed out'));
      }, 8_000);
      for (const [stream, stderr] of [[child.stdout, false], [child.stderr, true]]) {
        stream.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 64 * 1024) {
            child.kill('SIGKILL');
            reject(new Error('child output exceeded limit'));
            return;
          }
          if (stderr) errors += chunk;
          else output += chunk;
        });
      }
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve({ output, errors });
        else reject(new Error('child failed: ' + code + ' ' + signal + ' ' + errors));
      });
    });
    // Attach rejection handlers immediately, including while waiting for the ready barrier.
    ready.catch(() => {});
    result.catch(() => {});
    return { child, ready, result };
  }
  const children = [startChild(), startChild()];
  try {
    expect(await Promise.all(children.map(({ ready }) => ready))).toEqual([{ initial: null }, { initial: null }]);
    for (const { child } of children) child.send('start');
    const results = await Promise.all(children.map(({ result }) => result));
    expect(results).toEqual([{ output: stdout, errors: '' }, { output: stdout, errors: '' }]);
    expect(fs.readFileSync(counter, 'utf8').split('\n')).toEqual(['compute', '']);
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(`${file}.lock.guard`)).toBe(false);
  } finally {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await Promise.allSettled(children.map(({ result }) => result));
  }
}, 15_000);
