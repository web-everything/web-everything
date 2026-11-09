import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBuildQueueLock, buildQueueCacheKey, readBuildQueueCache, waitForBuildQueueCache, writeBuildQueueCache } from '../build-queue-cache.mjs';
const dirs = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-cache-test-')); dirs.push(dir);
  const backlogDir = join(dir, 'backlog'); mkdirSync(backlogDir);
  const configPath = join(dir, 'config.json'); writeFileSync(configPath, '{}');
  writeFileSync(join(backlogDir, 'a.md'), 'a');
  return { dir, backlogDir, configPath };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
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
  expect(statSync(`${file}.lock`).isDirectory()).toBe(true);
  try {
    expect(readBuildQueueCache({ file, key })).toBeNull();
    expect(acquireBuildQueueLock({ file })).toBeNull();
    writeBuildQueueCache({ file, key, stdout });
  } finally { release(); }
  expect(waitForBuildQueueCache({ file, key, timeoutMs: 25, pollMs: 5 })).toBe(stdout);
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

it('expires cached stdout at the default 60 second TTL', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeBuildQueueCache({ file, key: 'key', at: 1_000, stdout: 'expired\n' });
  expect(readBuildQueueCache({ file, key: 'key', now: 60_999 })).toBe('expired\n');
  expect(readBuildQueueCache({ file, key: 'key', now: 61_000 })).toBeNull();
});

it('fails open on a corrupt cache file with null from read and timed-out wait', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  writeFileSync(file, '{invalid json');
  expect(readBuildQueueCache({ file, key: 'key' })).toBeNull();
  const started = Date.now();
  expect(waitForBuildQueueCache({ file, key: 'key', timeoutMs: 25, pollMs: 5 })).toBeNull();
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
});

it('reclaims a lock older than staleMs even when its recorded pid is alive', () => {
  const { dir } = setup(); const file = join(dir, 'cache.json');
  expect(acquireBuildQueueLock({ file, now: 1_000, staleMs: 100, pid: process.pid })).toBeTypeOf('function');
  expect(acquireBuildQueueLock({ file, now: 1_099, staleMs: 100 })).toBeNull();
  const release = acquireBuildQueueLock({ file, now: 1_101, staleMs: 100 });
  expect(release).toBeTypeOf('function');
  try {
    expect(acquireBuildQueueLock({ file, now: 1_102, staleMs: 100 })).toBeNull();
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
