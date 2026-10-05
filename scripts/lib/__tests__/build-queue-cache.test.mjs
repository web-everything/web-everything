import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueueCacheKey, readBuildQueueCache, writeBuildQueueCache } from '../build-queue-cache.mjs';
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
