// tmp-leak fix (2026-10-04): the run-scoped temp root that stops vitest runs leaking into `$TMPDIR`.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RUN_ROOT_PARENT,
  DEFAULT_LEAK_MAX,
  resolveTmpLeakPolicy,
  createRunTmpRoot,
  sweepStaleRunRoots,
  summarizeLeftovers,
  finishRunTmpRoot,
  lazyTmpPath,
  createSharedFakeGh,
  removeSharedDir,
  ensureTestTmpDir,
  SHARED_DIR_NAME,
} from '../lib/test-tmp-root.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
let base;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'tmp-root-test-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('resolveTmpLeakPolicy', () => {
  it('defaults to warn with the default max', () => {
    expect(resolveTmpLeakPolicy({})).toEqual({ mode: 'warn', max: DEFAULT_LEAK_MAX, keep: false });
  });
  it('reads mode, max and keep from env; ignores junk', () => {
    expect(resolveTmpLeakPolicy({ WE_TMP_LEAK_MODE: 'FAIL', WE_TMP_LEAK_MAX: '3', WE_TMP_LEAK_KEEP: '1' }))
      .toEqual({ mode: 'fail', max: 3, keep: true });
    expect(resolveTmpLeakPolicy({ WE_TMP_LEAK_MODE: 'bogus', WE_TMP_LEAK_MAX: '-2' }))
      .toEqual({ mode: 'warn', max: DEFAULT_LEAK_MAX, keep: false });
  });
});

describe('run root lifecycle', () => {
  it('creates the root under <base>/we-vitest/<pid>-*', () => {
    const root = createRunTmpRoot({ baseTmp: base, pid: 4242 });
    expect(root.startsWith(join(base, RUN_ROOT_PARENT, '4242-'))).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  it('counts leftovers by prefix, then removes the root', () => {
    const root = createRunTmpRoot({ baseTmp: base });
    for (let i = 0; i < 3; i++) mkdtempSync(join(root, 'leaky-thing-'));
    mkdtempSync(join(root, 'other-'));
    expect(summarizeLeftovers(root).byPrefix).toEqual([
      { prefix: 'leaky-thing', count: 3 },
      { prefix: 'other', count: 1 },
    ]);
    const logs = [];
    const verdict = finishRunTmpRoot({ root, policy: { mode: 'warn', max: 2, keep: false }, log: (m) => logs.push(m) });
    expect(verdict).toMatchObject({ count: 4, exceeded: true, failed: false });
    expect(logs[0]).toMatch(/3× leaky-thing/);
    expect(existsSync(root)).toBe(false);
  });

  it('fails only in fail mode, stays quiet under the max, and keeps the root on request', () => {
    const root = createRunTmpRoot({ baseTmp: base });
    mkdtempSync(join(root, 'x-'));
    const logs = [];
    expect(finishRunTmpRoot({ root, policy: { mode: 'fail', max: 1, keep: true }, log: (m) => logs.push(m) }))
      .toMatchObject({ count: 1, exceeded: false, failed: false });
    expect(logs).toEqual([]);
    expect(existsSync(root)).toBe(true);
    expect(finishRunTmpRoot({ root, policy: { mode: 'fail', max: 0, keep: false }, log: () => {} }))
      .toMatchObject({ exceeded: true, failed: true });
  });

  it('sweeps only dead-pid roots older than the min age', () => {
    const parent = join(base, RUN_ROOT_PARENT);
    mkdirSync(parent, { recursive: true });
    const deadOld = mkdtempSync(join(parent, '111-'));
    const deadNew = mkdtempSync(join(parent, '222-'));
    const aliveOld = mkdtempSync(join(parent, '333-'));
    const notOurs = mkdtempSync(join(parent, 'stranger-'));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    for (const d of [deadOld, aliveOld, notOurs]) utimesSync(d, old, old);
    const removed = sweepStaleRunRoots({ baseTmp: base, isAlive: (pid) => pid === 333 });
    expect(removed).toEqual([deadOld]);
    expect(readdirSync(parent).sort()).toEqual([deadNew, aliveOld, notOurs].map((d) => d.slice(parent.length + 1)).sort());
  });
});

// Guard: every vitest config that loads the shared setup file must also load the run-root globalSetup, and
// the setup file must route its per-file temp dirs through `ownedTmpDir` (removed in afterAll). Before this
// fix the setup file leaked 4 dirs per test file (~1.15M on the operator's Mac).
describe('tmp-leak guard', () => {
  it('each config with vitest.setup.ts also wires vitest.globalSetup.mjs', () => {
    const configs = readdirSync(repoRoot).filter((f) => /^vitest\..*config\.ts$/.test(f));
    const missing = configs.filter((f) => {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      return src.includes('vitest.setup.ts') && !src.includes('vitest.globalSetup.mjs');
    });
    expect(missing).toEqual([]);
  });

  it('vitest.setup.ts creates no un-owned module-level temp dirs', () => {
    const src = readFileSync(join(repoRoot, 'vitest.setup.ts'), 'utf8');
    const raw = src.split('\n').filter((l) => /mkdtempSync\(/.test(l) && !/^\s*\/\//.test(l));
    // Allowed: only the fallback fake-`gh` dir (used when no globalSetup shared one), which is pushed onto
    // `ownedTmpDirs` on the next line and removed in afterAll. Every other root is a lazy, un-created path.
    expect(raw.map((l) => l.trim())).toEqual([
      "fakeGhDir = mkdtempSync(join(tmpdir(), 'we-fake-gh-'));",
    ]);
    expect(src).toMatch(/fakeGhDir = mkdtempSync[^\n]*\n\s*ownedTmpDirs\.push\(fakeGhDir\)/);
  });
});

describe('lazy and shared temp state (test-churn cut)', () => {
  it('lazyTmpPath returns a unique path without creating it', () => {
    const a = lazyTmpPath('we-test-', base);
    expect(a).not.toBe(lazyTmpPath('we-test-', base));
    expect(existsSync(a)).toBe(false);
  });
  it('ensureTestTmpDir creates the env root on demand and fails loudly when unset', () => {
    const dir = join(base, 'x', 'y');
    expect(ensureTestTmpDir('K', { K: dir })).toBe(dir);
    expect(existsSync(dir)).toBe(true);
    expect(() => ensureTestTmpDir('K', {})).toThrow(/not set/);
  });
  it('the shared fake gh fails like an unauthenticated gh, and is not counted as a leftover', () => {
    const dir = createSharedFakeGh(base);
    expect(readFileSync(join(dir, 'gh'), 'utf8')).toContain('exit 1');
    expect(summarizeLeftovers(base).count).toBe(1); // only the shared dir itself
    removeSharedDir(base);
    expect(existsSync(join(base, SHARED_DIR_NAME))).toBe(false);
    expect(summarizeLeftovers(base).count).toBe(0);
  });
  it('vitest.setup.ts takes the shared fake gh from globalSetup (one write per run)', () => {
    expect(readFileSync(join(repoRoot, 'vitest.globalSetup.mjs'), 'utf8')).toContain('createSharedFakeGh(root)');
    expect(readFileSync(join(repoRoot, 'vitest.setup.ts'), 'utf8')).not.toMatch(/^\s*[^/\s][^\n]*writeFileSync\(/m);
  });
});
