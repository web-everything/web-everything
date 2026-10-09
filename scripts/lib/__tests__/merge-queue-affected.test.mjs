/**
 * @file scripts/lib/__tests__/merge-queue-affected.test.mjs
 * @description The merge queue's `affected` re-test mode (operator go 2026-10-09 16:35 ET): an unaffected PR merges
 *   without a refresh; a PR main's new code can reach, or any change to the gate itself, still refreshes. Replays the
 *   2026-10-09 red-main pair (#4453 + #4547) to prove `affected` still refreshes the PR that broke main.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAffected, readAffectedFacts, isGateFile, DEFAULT_RETEST_MODE } from '../merge-queue-affected.mjs';
import { resolvedImportsOf } from '../related-test-selection.mjs';
import {
  loadMergeQueueSettings, decideMergeQueueAction, readRetestFacts, classifyMergeQueueSkip, MERGE_QUEUE_RETEST_MODE_ENV,
} from '../merge-queue-hook.mjs';
import { SETTINGS_DIR } from '../settings-files.mjs';

const none = () => [];

describe('decideAffected (pure)', () => {
  it('main gained only docs/backlog → not affected, no graph needed', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/x.md', 'backlog/1-x.md'], importsOf: () => { throw new Error('no IO'); } });
    expect(r).toEqual({ affected: false, reasons: ['main-gained-no-code'], mainCodeFiles: 0 });
  });
  it('unrelated code on main → not affected', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: none });
    expect(r).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'], mainCodeFiles: 1 });
  });
  it('same file on both sides → affected', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/a.mjs'], importsOf: none }).reasons).toEqual(['same-file:scripts/a.mjs']);
  });
  it('a main file that imports a PR file → affected (read at the main tip)', () => {
    const importsOf = (side, f) => (side === 'main' && f === 'scripts/z.mjs' ? ['scripts/a.mjs'] : []);
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf });
    expect(r).toMatchObject({ affected: true, reasons: ['main-file-imports-pr-file:scripts/z.mjs->scripts/a.mjs'] });
  });
  it('a PR file that imports a main file → affected (read at the PR head)', () => {
    const importsOf = (side, f) => (side === 'pr' && f === 'scripts/a.mjs' ? ['scripts/lib/z.mjs'] : []);
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/lib/z.mjs'], importsOf });
    expect(r.reasons).toEqual(['pr-file-imports-main-file:scripts/a.mjs->scripts/lib/z.mjs']);
  });
  it('an unreadable import list fails closed', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: () => null });
    expect(r).toMatchObject({ affected: true, reasons: ['imports-unreadable:main:scripts/z.mjs'] });
  });
  it.each([
    'scripts/merge-ai-prs.mjs', 'scripts/lib/merge-queue-hook.mjs', 'scripts/lib/merge-freshness.mjs', '.github/workflows/ci.yml',
    'package.json', 'package-lock.json', 'vitest.config.ts', 'tsconfig.json', 'scripts/__tests__/fixtures/shared-git-fixture.mjs', 'scripts/ci/shard-assign.mjs',
  ])('the gate itself (%s) on EITHER side always re-tests', (gate) => {
    expect(isGateFile(gate)).toBe(true);
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: [gate], importsOf: none })).toMatchObject({ affected: true, reasons: [`gate-touched:${gate}`] });
    expect(decideAffected({ prFiles: [gate], mainFiles: ['scripts/z.mjs'], importsOf: none })).toMatchObject({ affected: true, reasons: [`gate-touched:${gate}`] });
  });
  it('a directory-discovered fixture root (glob edge) re-tests: the import graph cannot see it', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['src/_data/intents/x.json'], importsOf: none }).reasons).toEqual(['glob-edge:src/_data/intents/x.json']);
  });
  it('the PR\'s own backlog card is not a glob edge (non-code)', () => {
    expect(decideAffected({ prFiles: ['backlog/x1-card.md', 'scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: none }).affected).toBe(false);
  });
});

describe('resolvedImportsOf (the shared import parser, forward direction)', () => {
  it('resolves relative imports against the file set, ignores bare specifiers', () => {
    const files = new Set(['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/c.mjs']);
    const text = "import x from './b.mjs';\nimport y from '../c.mjs';\nimport 'node:fs';\nawait import('./missing.mjs');";
    expect(resolvedImportsOf('scripts/lib/a.mjs', text, files).sort()).toEqual(['scripts/c.mjs', 'scripts/lib/b.mjs']);
  });
});

/** A fake git over two trees: `{ [sha]: { [path]: content } }`. */
function fakeGit(trees, { fetchable = true } = {}) {
  const present = new Set(fetchable ? [] : Object.keys(trees));
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'cat-file') {
      const [sha, path] = args[2].replace('^{commit}', '').split(':');
      if (!present.has(sha)) throw new Error('missing commit');
      if (path !== undefined && !(path in trees[sha])) throw new Error('missing path');
      return '';
    }
    if (cmd === 'fetch') { if (fetchable) for (const s of Object.keys(trees)) present.add(s); return ''; }
    if (cmd === 'ls-tree') return Object.keys(trees[args[3]]).join('\n');
    if (cmd === 'show') { const [sha, path] = args[1].split(/:(.*)/s); if (!(path in (trees[sha] ?? {}))) throw new Error('no path'); return trees[sha][path]; }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}

describe('readAffectedFacts (IO, injected git)', () => {
  const HEAD = 'h'.repeat(40);
  const TIP = 't'.repeat(40);
  it('fetches missing commits, then finds no edge → not affected', () => {
    const { git, calls } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import './util.mjs';", 'scripts/util.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/util.mjs': '', 'scripts/z.mjs': "import './util.mjs';" },
    });
    const r = readAffectedFacts({ num: 7, headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git });
    expect(r).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'] });
    expect(calls.some((c) => c.startsWith('fetch'))).toBe(true);
  });
  it('a main file that now imports the PR file (new edge at the tip) → affected', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/z.mjs': "import { a } from './a.mjs';" },
    });
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git }).reasons)
      .toEqual(['main-file-imports-pr-file:scripts/z.mjs->scripts/a.mjs']);
  });
  it('a file the PR deleted reads as importing nothing (not a failure)', () => {
    const { git } = fakeGit({ [HEAD]: {}, [TIP]: { 'scripts/gone.mjs': '', 'scripts/z.mjs': '' } });
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/gone.mjs'], mainFiles: ['scripts/z.mjs'], git }).affected).toBe(false);
  });
  it('commits the clone cannot produce (another repo) → affected, fail closed', () => {
    const { git } = fakeGit({ [HEAD]: {}, [TIP]: {} }, { fetchable: false });
    const g = (args) => { if (args[0] === 'cat-file') throw new Error('missing'); return git(args); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git: g }).reasons[0]).toMatch(/^commits-unavailable:/);
  });
  it('no git IO at all when main gained no code or the gate is touched', () => {
    const git = () => { throw new Error('no IO expected'); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/x.md'], git }).affected).toBe(false);
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['package.json'], git }).affected).toBe(true);
  });
});

describe('settings cascade: built-in default → settings file → env', () => {
  const FILE = JSON.parse(readFileSync(join(SETTINGS_DIR, 'merge-queue.json'), 'utf8'));
  it('the built-in default is affected; the declared file says affected', () => {
    expect(DEFAULT_RETEST_MODE).toBe('affected');
    expect(loadMergeQueueSettings({ file: {}, env: {} }).freshness.retestMode).toBe('affected');
    expect(FILE.mergeFreshness.retestMode).toBe('affected');
  });
  it('any-code stays selectable (file and env); env wins; an unknown mode falls back to any-code', () => {
    expect(loadMergeQueueSettings({ file: { mergeFreshness: { retestMode: 'any-code' } }, env: {} }).freshness.retestMode).toBe('any-code');
    expect(loadMergeQueueSettings({ file: FILE, env: { [MERGE_QUEUE_RETEST_MODE_ENV]: 'any-code' } }).freshness.retestMode).toBe('any-code');
    const bad = loadMergeQueueSettings({ file: { mergeFreshness: { retestMode: 'yolo' } }, env: {} });
    expect(bad.freshness.retestMode).toBe('any-code');
    expect(bad.errors.join()).toMatch(/retestMode/);
  });
});

describe('decideMergeQueueAction with the affected verdict', () => {
  const LIVE = loadMergeQueueSettings({ file: JSON.parse(readFileSync(join(SETTINGS_DIR, 'merge-queue.json'), 'utf8')), env: {} });
  const ANY = { ...LIVE, freshness: { ...LIVE.freshness, retestMode: 'any-code' } };
  const now = Date.parse('2026-10-09T20:00:00Z');
  const facts = (affected, ageMin = 5) => ({
    pr: { headSha: 'h', baseSha: 'b', files: ['scripts/a.mjs'], filesComplete: true,
      requiredCheck: { state: 'passed', headSha: 'h', completedAtMs: now - ageMin * 60_000, runId: '1', checkRunId: 1 } },
    main: { tipSha: 't', commitsSinceBase: 3, filesChangedSinceBase: ['scripts/z.mjs'], complete: true },
    errors: [], ...(affected ? { affected } : {}),
  });
  const UNAFFECTED = { affected: false, reasons: ['main-delta-unaffected'], mainCodeFiles: 1 };
  it('unaffected → merge without a re-test, with the reason', () => {
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(UNAFFECTED), nowMs: now, settings: LIVE }))
      .toEqual({ action: 'merge', reasons: ['retest-skipped', 'unaffected:main-delta-unaffected'] });
  });
  it('unaffected also excuses an old pass (age only stood in for "main moved")', () => {
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(UNAFFECTED, 120), nowMs: now, settings: LIVE }).action).toBe('merge');
  });
  it('affected → refresh, naming why', () => {
    const r = decideMergeQueueAction({ key: 'k', num: 1, facts: facts({ affected: true, reasons: ['same-file:scripts/z.mjs'] }), nowMs: now, settings: LIVE });
    expect(r).toEqual({ action: 'refresh', reasons: ['main-gained-code', 'base-behind-main', 'affected:same-file:scripts/z.mjs'] });
  });
  it('any-code mode ignores the verdict (today\'s middle ground)', () => {
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(UNAFFECTED), nowMs: now, settings: ANY }))
      .toEqual({ action: 'refresh', reasons: ['main-gained-code', 'base-behind-main'] });
  });
  it('no verdict (facts incomplete / not computed) → any-code behaviour', () => {
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(null), nowMs: now, settings: LIVE }).action).toBe('refresh');
  });
  it('a failed or pending required check is never excused', () => {
    const f = facts(UNAFFECTED);
    f.pr.requiredCheck = { ...f.pr.requiredCheck, state: 'failed' };
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: f, nowMs: now, settings: LIVE }).action).toBe('refuse');
  });
  it('replay 2026-10-09: #4547 (the PR that broke main with #4453) is still refreshed — main gained the gate itself', () => {
    // Real main delta for #4547 included scripts/merge-ai-prs.mjs; #4547 itself touched package.json + vitest configs.
    const v = decideAffected({ prFiles: ['package.json', 'scripts/lib/hermetic-tests.mjs'], mainFiles: ['scripts/merge-ai-prs.mjs', 'scripts/conveyor/prep-review.mjs'], importsOf: none });
    expect(v.affected).toBe(true);
    expect(decideMergeQueueAction({ key: 'k', num: 4547, facts: facts(v), nowMs: now, settings: LIVE }).action).toBe('refresh');
  });
});

describe('readRetestFacts (the hook IO seam)', () => {
  const pr = { headSha: 'h', files: ['scripts/a.mjs'], filesComplete: true };
  const main = { tipSha: 't', commitsSinceBase: 2, filesChangedSinceBase: ['scripts/z.mjs'], complete: true };
  it('logs one machine-readable line with the verdict', () => {
    const lines = [];
    const v = readRetestFacts({ num: 9, pr, main, retest: { mode: 'affected', readAffected: () => ({ affected: false, reasons: ['main-delta-unaffected'], mainCodeFiles: 1, ms: 3 }), log: (l) => lines.push(l) } });
    expect(v.affected).toBe(false);
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0].replace(/^merge-queue · retest: /, ''));
    expect(row).toMatchObject({ num: 9, mode: 'affected', affected: false, reasons: ['main-delta-unaffected'], mainCodeFiles: 1 });
  });
  it('any-code mode, incomplete facts, or a test run without an explicit seam → no verdict, no IO', () => {
    const boom = () => { throw new Error('no IO'); };
    expect(readRetestFacts({ num: 9, pr, main, retest: { mode: 'any-code', readAffected: boom } })).toBeNull();
    expect(readRetestFacts({ num: 9, pr: { ...pr, filesComplete: false }, main, retest: { mode: 'affected', readAffected: boom } })).toBeNull();
    expect(readRetestFacts({ num: 9, pr, main, env: { VITEST: 'true' } })).toBeNull();
  });
});

describe('classifyMergeQueueSkip — real 2026-10-09 drain reasons, previously `unrecognized-reason`', () => {
  it.each([
    ['merge-queue: refresh (main-gained-code, base-behind-main) → rebased', 'merge-queue-refresh'],
    ['merge-queue: refresh (base-behind-main) → rebased', 'merge-queue-refresh'],
    ['merge-queue: refresh (main-gained-code, base-behind-main) → error failed: push to lane/prepare-la', 'merge-queue-refresh-failed'],
    ['merge-queue: refuse (facts-incomplete; read errors: check-runs: gh read failed (exit): gh-throttle: GitHub core API rate limit exceeded', 'merge-queue-gh-throttled'],
    ['merge-queue: refuse (facts-incomplete)', 'merge-queue-facts-incomplete'],
    ['merge-queue: wait (refresh-already-requested)', 'merge-queue-wait'],
    ['merge-queue: refuse (required-check-failed)', 'merge-queue-refuse'],
  ])('%s → %s', (reason, kind) => { expect(classifyMergeQueueSkip(reason)).toBe(kind); });
  it('a non-merge-queue reason is not claimed', () => { expect(classifyMergeQueueSkip('required check "test" is not green')).toBeNull(); });
});
