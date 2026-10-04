/**
 * @file scripts/__tests__/repo-scan-tests.test.mjs
 * @description #3887 — verify's `vitest related` selection never picks a repo-SCANNING test (it reads files from
 *   disk and imports nothing), so a new file with a hard-coded repo slug passed local verify and failed CI. This
 *   pins: the selection (scoped to the changed files, full only where unscopable), the guard that a new scanning
 *   test cannot be added without being marked, and the #3887 regression itself, end to end through the real test.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFERRED_SCAN_TESTS, REPO_SCAN_TESTS, SCAN_FILES_ENV, SCAN_TEST_TAG,
  scanCommands, scanScope, scopedScanFiles, selectScanTests,
} from '../lib/repo-scan-tests.mjs';
import { resolveDefaultGate } from '../lib/verify-lane-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MULTI = 'scripts/__tests__/multi-repo-checks.test.mjs';

describe('selectScanTests', () => {
  it('a changed file inside a scanner reach selects it, scoped to that file', () => {
    const { scoped, full, scopedFiles } = selectScanTests({ changedFiles: ['scripts/lib/new-thing.mjs'] });
    expect(scoped.map((e) => e.test)).toContain(MULTI);
    expect(scopedFiles).toEqual(['scripts/lib/new-thing.mjs']);
    // review-policy.conformance cannot be scoped: it runs FULL, but only because a source file changed.
    expect(full.map((e) => e.scope)).toEqual(['full']);
  });

  it('a docs-only or backlog-only change runs no scanner (cost stays zero)', () => {
    expect(selectScanTests({ changedFiles: ['docs/agent/x.md', 'backlog/1-x.md'] })).toEqual({ scoped: [], full: [], widened: [], scopedFiles: [] });
    expect(scanCommands({ changedFiles: null })).toEqual([]);
  });

  it('a change to a scanner\'s own rule/data runs it FULL, never scoped', () => {
    const { scoped, widened } = selectScanTests({ changedFiles: ['scripts/lib/we-only-checks.json'] });
    expect(widened.map((e) => e.test)).toContain(MULTI);
    expect(scoped.map((e) => e.test)).not.toContain(MULTI);
    expect(scanCommands({ changedFiles: ['scripts/lib/we-only-checks.json'] }).at(-1)).toBe(`npx vitest run '${MULTI}'`);
  });

  it('emits ONE command carrying the changed list (scoped + by-design-full scanners share a vitest startup)', () => {
    const cmds = scanCommands({ changedFiles: ['scripts/lib/a.mjs', 'docs/x.md'] });
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toContain(`${SCAN_FILES_ENV}='["scripts/lib/a.mjs"]' npx vitest run`);
    expect(cmds[0]).toContain('review-policy.conformance');
  });
});

describe('scan scope helpers', () => {
  it('unset means scan everything; set narrows; malformed fails loudly', () => {
    expect(scanScope({})).toBeNull();
    expect(scopedScanFiles(['a', 'b'], {})).toEqual(['a', 'b']);
    expect(scopedScanFiles(['a', 'b'], { [SCAN_FILES_ENV]: '["b"]' })).toEqual(['b']);
    expect(() => scanScope({ [SCAN_FILES_ENV]: '{"a":1}' })).toThrow();
    expect(() => scanScope({ [SCAN_FILES_ENV]: 'a,b' })).toThrow();
  });
});

describe('the verify gate wires the scanners in', () => {
  const git = (changed) => (args) => {
    if (args[0] === 'merge-base') return 'mb\n';
    if (args[0] === 'diff') return args.includes('--diff-filter=D') ? '' : changed.join('\n');
    if (args[0] === 'ls-files') return '';
    if (args[0] === 'grep') return '';
    return '';
  };
  it('a new scanned file adds the scoped scan to the gate command; docs-only leaves it unchanged', () => {
    const withScan = resolveDefaultGate({ runGit: git(['scripts/lib/new-thing.mjs']), env: {}, fileExists: () => true });
    expect(withScan.scanCommands.length).toBeGreaterThan(0);
    expect(withScan.command).toContain(SCAN_FILES_ENV);
    expect(withScan.command.indexOf('vitest related')).toBeLessThan(withScan.command.indexOf(SCAN_FILES_ENV));
    expect(withScan.command.indexOf(SCAN_FILES_ENV)).toBeLessThan(withScan.command.indexOf('check:standards'));
    const docs = resolveDefaultGate({ runGit: git(['docs/readme.md']), env: {}, fileExists: () => true });
    expect(docs.scanCommands).toEqual([]);
    expect(docs.command).not.toContain(SCAN_FILES_ENV);
    // a checkout without the scanner tests (a sibling repo, a fixture) gets no scan half, and so no missing-file failure
    expect(resolveDefaultGate({ runGit: git(['scripts/lib/new-thing.mjs']), env: {}, fileExists: () => false }).scanCommands).toEqual([]);
    expect(resolveDefaultGate({ runGit: git(['scripts/lib/new-thing.mjs']), env: {} }).scanCommands).toEqual([]);
  });
});

// ── The guard: a scanning test cannot exist unmarked ──────────────────────────────────────────────────────
// A "scanner" = a test that walks the real repo tree (or `git ls-files` of it) to enforce a rule. Heuristic, so
// it errs toward detecting; the answer to a detection is to mark the test (REPO_SCAN_TESTS) or defer it with a
// reason (DEFERRED_SCAN_TESTS) — either way a human decides, which is the point.
const SCANNER_SHAPES = [
  /ls-files[^;]{0,200}cwd:\s*(ROOT|root|REPO_ROOT|repoRoot|REPO)\b/s,
  /readdirSync\([^)]*\b(ROOT|root|REPO_ROOT)\b[^)]*recursive/s,
  /(?:const walk = |function walk\()/,
  /readdirSync\(\s*(?:resolve|join)\((?:ROOT|root)/,
];
const trackedTests = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard', '*.test.mjs', '*.test.ts', '*.test.js'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f && !f.includes('node_modules'));

describe('guard: every repo-scanning test is marked or deferred with a reason', () => {
  it('no detected scanner is unaccounted for', () => {
    const marked = new Set(REPO_SCAN_TESTS.map((e) => e.test));
    const unaccounted = trackedTests().filter((f) => existsSync(join(root, f))
      && f !== 'scripts/__tests__/repo-scan-tests.test.mjs'
      && SCANNER_SHAPES.some((re) => re.test(readFileSync(join(root, f), 'utf8')))
      && !marked.has(f) && !(f in DEFERRED_SCAN_TESTS));
    expect(unaccounted, `repo-scanning test(s) not in scripts/lib/repo-scan-tests.mjs — add to REPO_SCAN_TESTS (scoped via scopedScanFiles/scanScope when possible) or DEFERRED_SCAN_TESTS with a reason, else \`verify\` never runs them (#3887)`).toEqual([]);
  });

  it('the heuristic is not vacuous: it detects the known scanners', () => {
    for (const e of REPO_SCAN_TESTS.filter((x) => x.test !== 'scripts/lib/__tests__/review-policy.conformance.test.mjs')) {
      expect(SCANNER_SHAPES.some((re) => re.test(readFileSync(join(root, e.test), 'utf8'))) || e.test.includes('multi-repo'), e.test).toBe(true);
    }
  });

  it('every marked test exists, carries the in-file tag, and scoped ones honour the scope env', () => {
    for (const e of REPO_SCAN_TESTS) {
      const src = readFileSync(join(root, e.test), 'utf8');
      expect(src, e.test).toContain(`${SCAN_TEST_TAG} scope=${e.scope}`);
      if (e.scope === 'files') expect(src, e.test).toMatch(/scanScope|scopedScanFiles/);
      expect(e.inputs.length, e.test).toBeGreaterThan(0);
      for (const input of e.inputs) expect(existsSync(join(root, input)), `${e.test} input ${input}`).toBe(true);
    }
  });

  it('every in-file tag is in the manifest (the mark cannot be applied without registering it)', () => {
    const tagged = trackedTests().filter((f) => existsSync(join(root, f)) && f !== 'scripts/__tests__/repo-scan-tests.test.mjs'
      && readFileSync(join(root, f), 'utf8').includes(`${SCAN_TEST_TAG} scope=`));
    expect(tagged.sort()).toEqual(REPO_SCAN_TESTS.map((e) => e.test).sort());
  });

  it('deferred entries name real tests and carry a reason', () => {
    for (const [f, why] of Object.entries(DEFERRED_SCAN_TESTS)) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(why.length, f).toBeGreaterThan(20);
    }
  });
});

// ── The #3887 regression, through the real scanning test ──────────────────────────────────────────────────
describe('#3887 regression: a NEW file with a repo literal is caught by the verify scan', () => {
  const rel = 'scripts/lib/__verify-scan-regression-3887.mjs';
  const run = (env) => spawnSync('npx', ['vitest', 'run', MULTI, '--reporter=dot'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });

  it('the gate selects the scan for the new file, and the scoped real test fails on it', () => {
    const abs = join(root, rel);
    try {
      writeFileSync(abs, "export const slug = 'frontier-ui/frontierui';\n");
      const cmds = scanCommands({ changedFiles: [rel] });
      expect(cmds[0]).toContain(JSON.stringify([rel]));
      const scoped = run({ [SCAN_FILES_ENV]: JSON.stringify([rel]) });
      expect(scoped.status, scoped.stdout + scoped.stderr).not.toBe(0);
      expect(scoped.stdout + scoped.stderr).toContain(rel);
    } finally { rmSync(abs, { force: true }); }
    // and with the offending file gone the same scoped scan is green (the failure was the file, not the scoping)
    const clean = run({ [SCAN_FILES_ENV]: JSON.stringify([rel]) });
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
  }, 60_000);
});
