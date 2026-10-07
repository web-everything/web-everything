/**
 * @file scripts/lib/__tests__/test-result-cache.test.mjs
 * @description prepare-124 S1 — the test-result cache key: what changes it, what must not, and when it is off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { cacheEnabled, createKeyContext, keyFor, listUnitTestFiles, parseVitestGlobs, classifyTier } from '../test-result-cache.mjs';

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
