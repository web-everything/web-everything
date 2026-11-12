/**
 * @file scripts/lib/__tests__/test-result-cache.test.mjs
 * @description prepare-124 S1 — the test-result cache key: what changes it, what must not, and when it is off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cacheEnabled, createKeyContext, keyFor, listUnitTestFiles, parseVitestGlobs, classifyTier } from '../test-result-cache.mjs';
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import * as testResultCache from '../test-result-cache.mjs';
import { execFileSync } from 'node:child_process';

const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function makeRepo(extra = {}) {
  const base = mkdtempSync(join(tmpdir(), 'trc-'));
  roots.push(base);
  const root = join(base, 'we');
  const files = {
    'vitest.config.ts': "import { x } from './vitest.shared';\nexport default {};\n",
    'vitest.shared.ts': 'export const x = 1;\n',
    'vitest.setup.ts': '',
    'vitest.globalSetup.mjs': '',
    'package.json': '{}', 'package-lock.json': '{}', 'tsconfig.json': '{}',
    'node_modules/.package-lock.json': '{}',
    'scripts/lib/dep.mjs': 'export const dep = 1;\n',
    'scripts/lib/unrelated.mjs': 'export const u = 1;\n',
    'scripts/lib/__tests__/a.test.mjs': "import { dep } from '../dep.mjs';\nit('a', () => dep);\n",
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); }
  return root;
}
const FILE = 'scripts/lib/__tests__/a.test.mjs';
const keyOf = (root, opts = {}) => keyFor(FILE, createKeyContext({ root, env: {}, nodeVersion: 'v22.1.0', vitestVersion: '3.0.0', policy: { deny: [], allow: [] }, ...opts }));
const write = (root, p, text) => writeFileSync(join(root, p), text);

describe('prepare-124 S1 — keyFor', () => {
  it('is stable for identical inputs and is cacheable', () => {
    const root = makeRepo();
    const a = keyOf(root);
    expect(a.cacheable).toBe(true);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(root).key).toBe(a.key);
  });

  it('changes when a closure file changes', () => {
    const root = makeRepo();
    const before = keyOf(root).key;
    write(root, 'scripts/lib/dep.mjs', 'export const dep = 2;\n');
    expect(keyOf(root).key).not.toBe(before);
  });

  it('changes when a global input changes (vitest setup, lockfile, installed lockfile)', () => {
    for (const path of ['vitest.shared.ts', 'vitest.setup.ts', 'package-lock.json', 'node_modules/.package-lock.json', 'tsconfig.json']) {
      const root = makeRepo();
      const before = keyOf(root).key;
      write(root, path, '// changed\n{}');
      expect(keyOf(root).key, path).not.toBe(before);
    }
  });

  it('changes with the full node version, vitest version and the timeout factor', () => {
    const root = makeRepo();
    const base = keyOf(root).key;
    expect(keyOf(root, { nodeVersion: 'v22.1.1' }).key).not.toBe(base);
    expect(keyOf(root, { vitestVersion: '3.0.1' }).key).not.toBe(base);
    expect(keyOf(root, { env: { WE_VERIFY_TEST_TIMEOUT_FACTOR: '2' } }).key).not.toBe(base);
    expect(keyOf(root, { env: { TZ: 'UTC' } }).key).not.toBe(base);
  });

  it('does not change when an unrelated file changes or a non-allowlisted env var differs', () => {
    const root = makeRepo();
    const base = keyOf(root).key;
    write(root, 'scripts/lib/unrelated.mjs', 'export const u = 99;\n');
    write(root, 'scripts/lib/other.mjs', 'x');
    expect(keyOf(root, { env: { SOME_RANDOM_VAR: '1' } }).key).toBe(base);
  });

  it('fails closed on an unresolvable relative import in a source file', () => {
    const root = makeRepo({ 'scripts/lib/dep.mjs': "import './missing.mjs';\n" });
    const k = keyOf(root);
    expect(k.cacheable).toBe(false);
    expect(k.key).toBeNull();
    expect(k.reason).toMatch(/unresolvable \.\/missing\.mjs/);
  });

  it('keys an unresolvable specifier in a test file as ABSENT, so creating the file changes the key', () => {
    const root = makeRepo({ [FILE]: "const code = `import './gen.mjs'`;\nit('a', () => code);\n" });
    const before = keyOf(root);
    expect(before.cacheable).toBe(true);
    write(root, 'scripts/lib/__tests__/gen.mjs', 'export {};\n');
    expect(keyOf(root).key).not.toBe(before.key);
  });

  it('resolves @frontierui/* into the sibling checkout, hashes it, and is uncacheable when it is missing', () => {
    const root = makeRepo({ [FILE]: "import { p } from '@frontierui/plugs/core';\nit('a', () => p);\n" });
    expect(keyOf(root).cacheable).toBe(false);
    expect(keyOf(root).reason).toMatch(/frontierui checkout missing/);
    const fui = join(dirname(root), 'frontierui', 'plugs');
    mkdirSync(fui, { recursive: true });
    write(dirname(root), 'frontierui/plugs/core.ts', 'export const p = 1;\n');
    const k1 = keyOf(root);
    expect(k1.cacheable).toBe(true);
    write(dirname(root), 'frontierui/plugs/core.ts', 'export const p = 2;\n');
    expect(keyOf(root).key).not.toBe(k1.key);
  });

  it('honours policy deny entries (with a reason) and never caches network or real-checkout tiers', () => {
    const root = makeRepo();
    const denied = keyOf(root, { policy: { deny: [{ pattern: FILE, reason: 'because', re: /^scripts\/lib\/__tests__\/a\.test\.mjs$/ }], allow: [] } });
    expect(denied.cacheable).toBe(false);
    expect(denied.reason).toContain('because');
    const net = makeRepo({ [FILE]: "it('a', async () => { await fetch('http://x'); });\n" });
    expect(keyOf(net).tier).toBe('network');
    expect(keyOf(net).cacheable).toBe(false);
  });

  it('is off under CI, GITHUB_ACTIONS and WE_TEST_CACHE=0', () => {
    expect(cacheEnabled({})).toBe(true);
    expect(cacheEnabled({ CI: '1' })).toBe(false);
    expect(cacheEnabled({ GITHUB_ACTIONS: 'true' })).toBe(false);
    expect(cacheEnabled({ WE_TEST_CACHE: '0' })).toBe(false);
    const root = makeRepo();
    const k = keyOf(root, { env: { CI: '1' } });
    expect(k.cacheable).toBe(false);
    expect(k.key).toBeNull();
  });
});

describe('prepare-124 S1 — file list and tiers', () => {
  it('lists unit test files from vitest.config.ts include and exclude', () => {
    const cfg = `export default { test: {
    include: [
      'scripts/**/__tests__/**/*.test.mjs', // c
      'blocks/**/__tests__/**/*.test.{ts,tsx}',
    ],
    exclude: [
      ...configDefaults.exclude,
      'scripts/__tests__/slow.test.mjs',
      'scripts/conveyor/__tests__/sim-*.test.mjs',
    ],
  } };`;
    expect(parseVitestGlobs(cfg).include).toHaveLength(2);
    const root = makeRepo({ 'vitest.config.ts': cfg });
    const files = ['scripts/a/__tests__/x.test.mjs', 'scripts/__tests__/slow.test.mjs', 'scripts/conveyor/__tests__/sim-1.test.mjs', 'blocks/b/__tests__/y.test.tsx', 'blocks/b/z.test.ts'];
    expect(listUnitTestFiles({ root, files })).toEqual(['blocks/b/__tests__/y.test.tsx', 'scripts/a/__tests__/x.test.mjs']);
  });

  it('classifies tiers with a documented precedence', () => {
    expect(classifyTier({ testText: "it('x',()=>1)" })).toBe('pure');
    expect(classifyTier({ testText: "const d = Date.now();" })).toBe('date');
    expect(classifyTier({ testText: "import x from '@frontierui/plugs/a'" })).toBe('fui');
    expect(classifyTier({ testText: "execFileSync('git', [], { cwd: ROOT })" })).toBe('checkout');
    expect(classifyTier({ testText: "const d = mkdtempSync(tmp); execFileSync('git', [], { cwd: d })" })).toBe('tierB');
    expect(classifyTier({ testText: "fetch('http://x')" })).toBe('network');
    expect(classifyTier({ testText: "it('x')", closureTexts: ["import { spawn } from 'node:child_process'"] })).toBe('pure-injected');
  });
});

describe('test-result cache retention', () => {
  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;
  const NOW = Date.UTC(2026, 10, 12, 12);
  const DEFAULTS = { maxAgeDays: 3, maxBytes: 15 * 1024 ** 3, minAgeMs: 6 * HOUR };
  const OLD = '20261101T120000-101-a1';
  const MIDDLE = '20261102T120000-102-b2';
  const FRESH = '20261112T110000-103-c3';
  const ACTIVE = '20261101T120000-104-d4';
  const makeCache = () => {
    const dir = mkdtempSync(join(tmpdir(), 'trc-retention-'));
    roots.push(dir);
    return dir;
  };
  const makeRun = (dir, name, ageMs, bytes = 8, now = NOW) => {
    const path = join(dir, 'traces', name);
    mkdirSync(join(path, 'nested'), { recursive: true });
    writeFileSync(join(path, 'nested', 'trace.log'), Buffer.alloc(bytes, 'x'));
    const time = new Date(now - ageMs);
    utimesSync(path, time, time);
    return path;
  };

  it('exports retention defaults and reports default setting provenance', () => {
    expect(testResultCache.TEST_CACHE_RETENTION_DEFAULTS).toEqual(DEFAULTS);
    const settings = testResultCache.retentionSettings({});
    expect(settings).toEqual({ ...DEFAULTS, source: expect.anything() });
    expect(JSON.stringify(settings.source)).toMatch(/default/i);
  });

  it('removes runs older than maxAgeDays and keeps fresh runs with exact byte accounting', () => {
    const dir = makeCache();
    const old = makeRun(dir, OLD, 4 * DAY, 11);
    const fresh = makeRun(dir, FRESH, HOUR, 7);
    const result = testResultCache.pruneCache({ dir, env: {}, now: NOW });
    expect(result).toEqual({
      removed: [OLD], freedBytes: 11, remainingBytes: 7,
      settings: testResultCache.retentionSettings({}),
    });
    expect(existsSync(old)).toBe(false);
    expect(readFileSync(join(fresh, 'nested', 'trace.log'), 'utf8')).toBe('xxxxxxx');
  });

  it('removes oldest runs first and stops as soon as remaining bytes are under the cap', () => {
    const dir = makeCache();
    // Names and creation order deliberately disagree with mtime order.
    const middle = makeRun(dir, OLD, 24 * HOUR, 8);
    const oldest = makeRun(dir, MIDDLE, 48 * HOUR, 8);
    const fresh = makeRun(dir, FRESH, HOUR, 8);
    const result = testResultCache.pruneCache({ dir, env: { WE_TEST_CACHE_MAX_BYTES: '17' }, now: NOW });
    expect(result.removed).toEqual([MIDDLE]);
    expect(result.freedBytes).toBe(8);
    expect(result.remainingBytes).toBe(16);
    expect(result.settings.maxBytes).toBe(17);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never removes runs younger than minAgeMs even when they alone exceed the cap', () => {
    const dir = makeCache();
    const oldest = makeRun(dir, OLD, 48 * HOUR, 8);
    const middle = makeRun(dir, MIDDLE, 24 * HOUR, 8);
    const fresh = makeRun(dir, FRESH, HOUR, 20);
    const result = testResultCache.pruneCache({ dir, env: { WE_TEST_CACHE_MAX_BYTES: '10' }, now: NOW });
    expect(result.removed).toEqual([OLD, MIDDLE]);
    expect(result.freedBytes).toBe(16);
    expect(result.remainingBytes).toBe(20);
    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(middle)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('never removes the active runId even when it is old and exceeds the byte cap', () => {
    const dir = makeCache();
    const active = makeRun(dir, ACTIVE, 10 * DAY, 20);
    makeRun(dir, OLD, 4 * DAY, 8);
    const result = testResultCache.pruneCache({ dir, env: { WE_TEST_CACHE_MAX_BYTES: '1' }, now: NOW, runId: ACTIVE });
    expect(result.removed).toEqual([OLD]);
    expect(result.freedBytes).toBe(8);
    expect(result.remainingBytes).toBe(20);
    expect(existsSync(active)).toBe(true);
  });

  it('leaves non-matching names, files and run-named symlinks untouched without following them', () => {
    const dir = makeCache();
    const outside = makeCache();
    writeFileSync(join(outside, 'sentinel'), 'outside');
    const names = ['notes', '20261101T120000-101-AF', `${OLD}-extra`, `prefix-${OLD}`];
    const paths = names.map((name) => makeRun(dir, name, 10 * DAY));
    const file = join(dir, 'traces', MIDDLE);
    writeFileSync(file, 'keep file');
    const time = new Date(NOW - 10 * DAY);
    utimesSync(file, time, time);
    const link = join(dir, 'traces', ACTIVE);
    symlinkSync(outside, link, 'dir');
    utimesSync(outside, time, time);
    makeRun(dir, OLD, 10 * DAY, 8);
    const result = testResultCache.pruneCache({ dir, env: { WE_TEST_CACHE_MAX_BYTES: '1' }, now: NOW });
    expect(result.removed).toEqual([OLD]);
    expect(result.freedBytes).toBe(8);
    expect(result.remainingBytes).toBe(0);
    for (const path of paths) expect(readFileSync(join(path, 'nested', 'trace.log'), 'utf8')).toBe('xxxxxxxx');
    expect(readFileSync(file, 'utf8')).toBe('keep file');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside');
  });

  it('uses the prune-stamp mtime to throttle within an hour and prunes again after an hour', () => {
    const dir = makeCache();
    makeRun(dir, OLD, 4 * DAY);
    const first = testResultCache.maybePruneCache({ dir, env: {}, now: NOW });
    expect(first.removed).toEqual([OLD]);
    const stamp = join(dir, '.prune-stamp');
    expect(statSync(stamp).isFile()).toBe(true);
    // Anchor the persisted stamp independently of the host's wall clock.
    utimesSync(stamp, new Date(NOW), new Date(NOW));
    const old = makeRun(dir, MIDDLE, 4 * DAY);
    expect(testResultCache.maybePruneCache({ dir, env: {}, now: NOW + HOUR - 1 })).toBeNull();
    expect(existsSync(old)).toBe(true);
    expect(statSync(stamp).mtimeMs).toBe(NOW);
    const next = testResultCache.maybePruneCache({ dir, env: {}, now: NOW + HOUR + 1 });
    expect(next.removed).toEqual([MIDDLE]);
    expect(existsSync(old)).toBe(false);
  });

  it('honours the age override and reports its environment provenance', () => {
    const dir = makeCache();
    makeRun(dir, OLD, 2 * DAY);
    const fresh = makeRun(dir, FRESH, 12 * HOUR);
    const env = { WE_TEST_CACHE_MAX_AGE_DAYS: '1', WE_TEST_CACHE_MAX_BYTES: '100' };
    const result = testResultCache.pruneCache({ dir, env, now: NOW });
    expect(result.removed).toEqual([OLD]);
    expect(existsSync(fresh)).toBe(true);
    expect(result.settings).toEqual({ maxAgeDays: 1, maxBytes: 100, minAgeMs: 6 * HOUR, source: expect.anything() });
    expect(JSON.stringify(result.settings.source)).toMatch(/WE_TEST_CACHE_MAX_AGE_DAYS/);
    expect(JSON.stringify(result.settings.source)).toMatch(/WE_TEST_CACHE_MAX_BYTES/);
  });

  it.each(['garbage', '0', '-1', 'Infinity', 'NaN', ''])('falls back for invalid/non-positive overrides %j and reports why', (value) => {
    for (const key of ['WE_TEST_CACHE_MAX_AGE_DAYS', 'WE_TEST_CACHE_MAX_BYTES']) {
      const settings = testResultCache.retentionSettings({ [key]: value });
      expect(settings).toEqual({ ...DEFAULTS, source: expect.anything() });
      expect(JSON.stringify(settings.source)).toContain(key);
      expect(JSON.stringify(settings.source)).toMatch(/invalid|non.positive|fallback|fall.*back/i);
      expect(JSON.stringify(settings.source)).toMatch(/default/i);
    }
  });

  it('uses the default age when an invalid age override is supplied', () => {
    const dir = makeCache();
    const kept = makeRun(dir, MIDDLE, 2 * DAY);
    makeRun(dir, OLD, 4 * DAY);
    const result = testResultCache.pruneCache({ dir, env: { WE_TEST_CACHE_MAX_AGE_DAYS: 'invalid' }, now: NOW });
    expect(result.removed).toEqual([OLD]);
    expect(existsSync(kept)).toBe(true);
  });

  it('createKeyContext leaves the store untouched without WE_TEST_CACHE_RUN_ID', () => {
    const root = makeRepo();
    const dir = makeCache();
    const old = makeRun(dir, OLD, 10 * DAY, 8, Date.now());
    keyOf(root, { env: { WE_TEST_CACHE_DIR: dir } });
    expect(existsSync(old)).toBe(true);
    expect(readdirSync(dir)).toEqual(['traces']);
  });

  it.each([{ WE_TEST_CACHE: '0' }, { CI: '1' }, { GITHUB_ACTIONS: 'true' }])('createKeyContext leaves the store untouched when disabled by %j', (disabled) => {
    const root = makeRepo();
    const dir = makeCache();
    const old = makeRun(dir, OLD, 10 * DAY, 8, Date.now());
    keyOf(root, { env: { WE_TEST_CACHE_DIR: dir, WE_TEST_CACHE_RUN_ID: ACTIVE, ...disabled } });
    expect(existsSync(old)).toBe(true);
    expect(readdirSync(dir)).toEqual(['traces']);
  });

  it('createKeyContext prunes the configured store only with a runId and throttles subsequent contexts', () => {
    const root = makeRepo();
    const dir = makeCache();
    const now = Date.now();
    const old = makeRun(dir, OLD, 10 * DAY, 8, now);
    const active = makeRun(dir, ACTIVE, 10 * DAY, 8, now);
    const env = { WE_TEST_CACHE_DIR: dir, WE_TEST_CACHE_RUN_ID: ACTIVE };
    keyOf(root, { env });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(active)).toBe(true);
    const stamp = join(dir, '.prune-stamp');
    expect(statSync(stamp).isFile()).toBe(true);
    utimesSync(stamp, new Date(now), new Date(now));
    const later = makeRun(dir, MIDDLE, 10 * DAY, 8, now);
    keyOf(root, { env });
    expect(existsSync(later)).toBe(true);
  });
  it('the prune CLI removes old runs in the configured store and prints the result as JSON', () => {
    const dir = makeCache();
    const old = makeRun(dir, OLD, 10 * DAY, 8, Date.now());
    const out = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'lib', 'test-result-cache.mjs'), 'prune'], { env: { ...process.env, WE_TEST_CACHE_DIR: dir }, encoding: 'utf8' });
    expect(existsSync(old)).toBe(false);
    expect(JSON.parse(out).removed).toBe(1);
  });
});
