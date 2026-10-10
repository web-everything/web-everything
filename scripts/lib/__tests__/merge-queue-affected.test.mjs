/**
 * @file scripts/lib/__tests__/merge-queue-affected.test.mjs
 * @description The merge queue's `affected` re-test mode (operator go 2026-10-09 16:35 ET): an unaffected PR merges
 *   without a refresh; a PR main's new code can reach, or any change to the gate itself, still refreshes. Replays the
 *   2026-10-09 red-main pair (#4453 + #4547) to prove `affected` still refreshes the PR that broke main.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideAffected as decideAffectedRule, readAffectedFacts, isGateFile, DEFAULT_RETEST_MODE, MAX_GRAPH_FILES, MAX_CLOSURE_FILES } from '../merge-queue-affected.mjs';
import { relativeSpecifierBases, resolvedImportsOf, specifierBasesResolvingTo } from '../related-test-selection.mjs';

/** The rule with no unchanged importers anywhere (the forward-walk cases below); a case that needs some passes `importersOf`. */
const decideAffected = (a) => decideAffectedRule({ importersOf: () => [], ...a });
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
  // Review round 5: the no-code shortcut answered before the gate rule, so a PR that edits the gate was "unaffected" by a
  // docs-only main move and its pass's age was excused. A change to the gate is never trusted to judge itself.
  it.each([
    'scripts/merge-ai-prs.mjs', 'scripts/lib/merge-queue-affected.mjs', 'scripts/settings/merge-queue.json', '.github/workflows/ci.yml',
    'package.json', 'vitest.config.ts', 'scripts/ci/shard-assign.mjs',
  ])('a PR that edits the gate (%s) re-tests even when main gained only docs/backlog', (gate) => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs', gate], mainFiles: ['docs/x.md', 'backlog/1-x.md'], importsOf: () => { throw new Error('no IO'); } });
    expect(r).toEqual({ affected: true, reasons: [`gate-touched:${gate}`], mainCodeFiles: 0 });
  });
  it('a gate-editing PR re-tests when main\'s file list is empty too (no shortcut around the gate rule)', () => {
    expect(decideAffected({ prFiles: ['scripts/merge-ai-prs.mjs'], mainFiles: [], importsOf: none }))
      .toEqual({ affected: true, reasons: ['gate-touched:scripts/merge-ai-prs.mjs'], mainCodeFiles: 0 });
  });
  it('a PR\'s own docs/backlog files are not the gate: docs-only main + docs-only PR stays unaffected', () => {
    expect(decideAffected({ prFiles: ['docs/y.md', 'backlog/2-y.md'], mainFiles: ['docs/x.md'], importsOf: none }).reasons).toEqual(['main-gained-no-code']);
  });
  it('unrelated code on main → not affected', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: none });
    expect(r).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'], mainCodeFiles: 1 });
  });
  // Deliberate non-regression pin, not a bug report: the accepted bound on card x0e6tik (operator ruling 2026-10-10). A SOURCE
  // file a test reads through `fs` as text has no import edge, so the rule cannot see the coupling. Closing it would re-test a
  // large share of PRs and erase the speed gain; tests still run on main and on the PR per settings, so a miss is caught later.
  it('documented bound (card x0e6tik): a source file read through fs, with no import edge, is not seen → not affected', () => {
    const r = decideAffected({ prFiles: ['scripts/scanner.test.mjs'], mainFiles: ['scripts/lib/new-source.mjs'], importsOf: none });
    expect(r).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'] });
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
    'scripts/settings/merge-queue.json', 'scripts/settings/anything-else.json',
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

/** A fake import graph: `{ pr: {file: [imports]}, main: {...} }`; a file absent from a side imports nothing there. */
const graph = (g) => (side, f) => g[side]?.[f] ?? [];

describe('decideAffected — transitive reachability (review round 1: the unchanged middle module)', () => {
  it('transitive main dependency forces refresh: PR file A → unchanged B → main-changed C', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/c.mjs'], importsOf: graph({ pr: { 'scripts/a.mjs': ['scripts/b.mjs'], 'scripts/b.mjs': ['scripts/c.mjs'] } }) });
    expect(r).toMatchObject({ affected: true, reasons: ['pr-file-imports-main-file:scripts/a.mjs->scripts/b.mjs->scripts/c.mjs'] });
  });
  it('transitive PR dependency forces refresh: main-changed C → unchanged B → PR file A (read at the main tip)', () => {
    const r = decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/c.mjs'], importsOf: graph({ main: { 'scripts/c.mjs': ['scripts/b.mjs'], 'scripts/b.mjs': ['scripts/a.mjs'] } }) });
    expect(r).toMatchObject({ affected: true, reasons: ['main-file-imports-pr-file:scripts/c.mjs->scripts/b.mjs->scripts/a.mjs'] });
  });
  it('a long chain (4 hops) is still followed', () => {
    const chain = { 'scripts/a.mjs': ['scripts/b.mjs'], 'scripts/b.mjs': ['scripts/c.mjs'], 'scripts/c.mjs': ['scripts/d.mjs'], 'scripts/d.mjs': ['scripts/z.mjs'] };
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: graph({ pr: chain }) }).affected).toBe(true);
  });
  it('an import cycle terminates, and a closure that never meets the other side is not affected', () => {
    const cyc = { 'scripts/a.mjs': ['scripts/b.mjs'], 'scripts/b.mjs': ['scripts/a.mjs', 'scripts/c.mjs'], 'scripts/c.mjs': ['scripts/b.mjs'] };
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: graph({ pr: cyc, main: cyc }) })).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'] });
  });
  it('the intermediate file is read on the right side: the PR side at the PR head, the main side at the tip', () => {
    // B imports C only at the main tip (main added the edge): the PR head's closure does not see it, the main closure from C does not reach A.
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/b2.mjs'], importsOf: graph({ pr: { 'scripts/a.mjs': ['scripts/b.mjs'] }, main: { 'scripts/b.mjs': ['scripts/b2.mjs'] } }) }).affected).toBe(false);
  });
  it('a closure larger than MAX_CLOSURE_FILES fails closed', () => {
    const wide = { 'scripts/a.mjs': Array.from({ length: MAX_CLOSURE_FILES + 5 }, (_, i) => `scripts/lib/dep${i}.mjs`) };
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: graph({ pr: wide }) }).reasons).toEqual(['closure-too-large:pr']);
  });
  it('an unreadable import list on the PR side (even mid-chain) fails closed', () => {
    const importsOf = (side, f) => (f === 'scripts/b.mjs' ? null : side === 'pr' && f === 'scripts/a.mjs' ? ['scripts/b.mjs'] : []);
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf }).reasons).toEqual(['imports-unreadable:pr:scripts/b.mjs']);
  });
  it('too many changed files on either side fails closed, without walking', () => {
    const many = Array.from({ length: MAX_GRAPH_FILES + 1 }, (_, i) => `scripts/lib/f${i}.mjs`);
    const boom = () => { throw new Error('no walk expected'); };
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: many, importsOf: boom }).reasons).toEqual(['too-many-files']);
    expect(decideAffected({ prFiles: many, mainFiles: ['scripts/z.mjs'], importsOf: boom }).reasons).toEqual(['too-many-files']);
  });
});

describe('resolvedImportsOf (the shared import parser, forward direction)', () => {
  it('resolves relative imports against the file set, ignores bare specifiers', () => {
    const files = new Set(['scripts/lib/a.mjs', 'scripts/lib/b.mjs', 'scripts/c.mjs']);
    const text = "import x from './b.mjs';\nimport y from '../c.mjs';\nimport 'node:fs';\nawait import('./missing.mjs');";
    expect(resolvedImportsOf('scripts/lib/a.mjs', text, files).sort()).toEqual(['scripts/c.mjs', 'scripts/lib/b.mjs']);
  });
  it('resolves a template-literal dynamic import by its static prefix (cache-busting `?v=${n}` loads)', () => {
    const files = new Set(['scripts/lib/a.mjs', 'scripts/pr-land.mjs']);
    expect(resolvedImportsOf('scripts/lib/a.mjs', 'await import(`../pr-land.mjs?fresh=${++n}`);', files)).toEqual(['scripts/pr-land.mjs']);
    expect(resolvedImportsOf('scripts/lib/a.mjs', 'await import(`../pr-land.mjs`);', files)).toEqual(['scripts/pr-land.mjs']);
  });
});

describe('specifier bases (a file the PR adds that a specifier already names)', () => {
  it('relativeSpecifierBases lists resolved and unresolved relative specifiers, not bare ones', () => {
    const text = "import a from './a.mjs';\nimport 'node:fs';\nawait import('../x/missing.mjs?v=1');\nimport b from 'lodash';";
    expect(relativeSpecifierBases('scripts/lib/m.mjs', text).sort()).toEqual(['scripts/lib/a.mjs', 'scripts/x/missing.mjs']);
  });
  it.each([
    ['scripts/foo.mjs', ['scripts/foo.mjs', 'scripts/foo']],
    ['scripts/dir/index.mjs', ['scripts/dir/index.mjs', 'scripts/dir/index', 'scripts/dir']],
    ['src/x.ts', ['src/x.ts', 'src/x', 'src/x.js']],
    ['src/y.mts', ['src/y.mts', 'src/y', 'src/y.mjs']],
  ])('specifierBasesResolvingTo(%s) covers every spelling that resolves to it', (path, expected) => {
    expect(specifierBasesResolvingTo(path).sort()).toEqual([...expected].sort());
  });
});

/** A fake git over two trees: `{ [sha]: { [path]: content } }`. */
function fakeGit(trees, { fetchable = true, batchFails = false } = {}) {
  const present = new Set(fetchable ? [] : Object.keys(trees));
  const calls = [];
  const git = (args, opts = {}) => {
    calls.push(args.join(' '));
    const [cmd] = args;
    if (cmd === 'cat-file' && args[1] === '--batch') { // `<sha>:<path>` per input line → `<oid> blob <size>\n<content>\n` | `<spec> missing\n`
      if (batchFails) throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
      return Buffer.from(String(opts.input).split('\n').filter(Boolean).map((spec) => {
        const [sha, path] = spec.split(/:(.*)/s);
        const body = trees[sha]?.[path];
        return body === undefined ? `${spec} missing\n` : `${'0'.repeat(40)} blob ${Buffer.byteLength(body)}\n${body}\n`;
      }).join(''));
    }
    if (cmd === 'cat-file') {
      const [sha, path] = args[2].replace('^{commit}', '').split(':');
      if (!present.has(sha)) throw new Error('missing commit');
      if (path !== undefined && !(path in trees[sha])) throw new Error('missing path');
      return '';
    }
    if (cmd === 'fetch') { if (fetchable) for (const s of Object.keys(trees)) present.add(s); return ''; }
    if (cmd === 'ls-tree') { if (!args.includes('-z')) throw new Error('ls-tree must be -z (quoted non-ASCII paths)'); return Object.keys(trees[args.at(-1)]).join('\0'); }
    if (cmd === 'show') { const [sha, path] = args[1].split(/:(.*)/s); if (!(path in (trees[sha] ?? {}))) throw new Error(`fatal: path '${path}' does not exist in '${sha}'`); return trees[sha][path]; }
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
  it('transitive through git: PR file → unchanged middle module → file main changed → affected', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import './mid.mjs';", 'scripts/mid.mjs': "import './c.mjs';", 'scripts/c.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/mid.mjs': "import './c.mjs';", 'scripts/c.mjs': 'export const x = 2;' },
    });
    const r = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/c.mjs'], git });
    expect(r).toMatchObject({ affected: true, reasons: ['pr-file-imports-main-file:scripts/a.mjs->scripts/mid.mjs->scripts/c.mjs'] });
  });
  it('transitive through git, the other way: main file → unchanged middle module → PR file → affected', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': '', 'scripts/mid.mjs': "import './a.mjs';", 'scripts/c.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/mid.mjs': "import './a.mjs';", 'scripts/c.mjs': "import './mid.mjs';" },
    });
    const r = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/c.mjs'], git });
    expect(r.reasons).toEqual(['main-file-imports-pr-file:scripts/c.mjs->scripts/mid.mjs->scripts/a.mjs']);
  });
  it('a shared module reached by several paths is read once per side', () => {
    const { git, calls } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import './m1.mjs'; import './m2.mjs';", 'scripts/m1.mjs': "import './shared.mjs';", 'scripts/m2.mjs': "import './shared.mjs';", 'scripts/shared.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/m1.mjs': '', 'scripts/m2.mjs': '', 'scripts/shared.mjs': '', 'scripts/z.mjs': '' },
    });
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git }).affected).toBe(false);
    expect(calls.filter((c) => c === `show ${HEAD}:scripts/shared.mjs`)).toHaveLength(1);
  });
  it('the PR side cannot read an import list (path exists but will not show) → imports-unreadable:pr, affected', () => {
    const { git } = fakeGit({ [HEAD]: { 'scripts/a.mjs': '' }, [TIP]: { 'scripts/a.mjs': '', 'scripts/z.mjs': '' } });
    const g = (args) => { if (args[0] === 'show' && args[1] === `${HEAD}:scripts/a.mjs`) throw new Error('corrupt object'); return git(args); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git: g }).reasons)
      .toEqual(['imports-unreadable:pr:scripts/a.mjs']);
  });
  it('a transient git failure reading an intermediate (not git\'s "no such path") fails closed, never "imports nothing"', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import './mid.mjs';", 'scripts/mid.mjs': "import './c.mjs';", 'scripts/c.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/mid.mjs': '', 'scripts/c.mjs': '', 'scripts/z.mjs': '' },
    });
    // both `show` and any follow-up probe fail with a non-"absent" error (EAGAIN-style)
    const g = (args) => { if (args[0] === 'show' && args[1] === `${HEAD}:scripts/mid.mjs`) throw new Error('spawnSync git EAGAIN'); return git(args); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git: g }).reasons)
      .toEqual(['imports-unreadable:pr:scripts/mid.mjs']);
  });
  it('a closure walk past the wall-clock budget fails closed (graph-budget-exceeded)', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import './m.mjs';", 'scripts/m.mjs': '' },
      [TIP]: { 'scripts/a.mjs': '', 'scripts/m.mjs': '', 'scripts/z.mjs': '' },
    });
    const r = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git, budgetMs: -1 });
    expect(r).toMatchObject({ affected: true });
    expect(r.reasons).toEqual(['graph-read-failed:graph-budget-exceeded']);
  });
  it('a PR file that imports a docs/ file main changed is coupled (non-code skips roots, not targets)', () => {
    const importsOf = (side, f) => (side === 'pr' && f === 'scripts/a.mjs' ? ['docs/data.json'] : []);
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/data.json', 'scripts/z.mjs'], importsOf }).reasons)
      .toEqual(['pr-file-imports-main-file:scripts/a.mjs->docs/data.json']);
  });
  it('missing shas fail closed without any git IO (shas-unknown)', () => {
    const git = () => { throw new Error('no IO expected'); };
    expect(readAffectedFacts({ headSha: '', tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git }).reasons).toEqual(['shas-unknown']);
    expect(readAffectedFacts({ headSha: HEAD, tipSha: undefined, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git }).reasons).toEqual(['shas-unknown']);
  });
  it('a git failure while reading the tree fails closed (graph-read-failed), never unaffected', () => {
    const { git } = fakeGit({ [HEAD]: { 'scripts/a.mjs': '' }, [TIP]: { 'scripts/a.mjs': '', 'scripts/z.mjs': '' } });
    const g = (args) => { if (args[0] === 'ls-tree') throw new Error('fatal: bad tree object\nsecond line'); return git(args); };
    const r = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], git: g });
    expect(r).toMatchObject({ affected: true });
    expect(r.reasons).toEqual(['graph-read-failed:fatal: bad tree object']);
  });
  it('too many changed files fails closed before any git IO (too-many-files)', () => {
    const git = () => { throw new Error('no IO expected'); };
    const many = Array.from({ length: MAX_GRAPH_FILES + 1 }, (_, i) => `scripts/lib/f${i}.mjs`);
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: many, mainFiles: ['scripts/z.mjs'], git }).reasons).toEqual(['too-many-files']);
  });
  it('no git IO at all when main gained no code or the gate is touched', () => {
    const git = () => { throw new Error('no IO expected'); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/x.md'], git }).affected).toBe(false);
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['package.json'], git }).affected).toBe(true);
  });
});

describe('decideAffected — shared unchanged importer (review round 2: the test that imports both sides)', () => {
  /** `importersOf` over a fake tip graph: `{ imported: [importing files] }`. */
  const importers = (m) => (f) => m[f] ?? [];
  const run = (a) => decideAffectedRule({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: none, ...a });
  it('[A1] an unchanged test that imports a PR file AND a main file → affected (neither forward walk sees it)', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/__tests__/t.test.mjs'], 'scripts/z.mjs': ['scripts/__tests__/t.test.mjs'] }) });
    expect(r).toMatchObject({ affected: true, reasons: ['shared-importer:scripts/__tests__/t.test.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)'] });
  });
  it('through an unchanged hub: test → hub → PR file, test → main file → affected (reverse closure, not direct importers)', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/hub.mjs'], 'scripts/hub.mjs': ['scripts/t.test.mjs'], 'scripts/z.mjs': ['scripts/t.test.mjs'] }) });
    expect(r.reasons).toEqual(['shared-importer:scripts/t.test.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
  });
  it('both sides reach the test only through different hubs → affected', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/h1.mjs'], 'scripts/z.mjs': ['scripts/h2.mjs'], 'scripts/h1.mjs': ['scripts/t.test.mjs'], 'scripts/h2.mjs': ['scripts/t.test.mjs'] }) });
    expect(r.affected).toBe(true);
  });
  it('a main-changed DATA file the test imports counts as a main root (changed data is never "no code")', () => {
    const r = run({ mainFiles: ['fixtures/z.json'], importersOf: importers({ 'scripts/a.mjs': ['scripts/t.test.mjs'], 'fixtures/z.json': ['scripts/t.test.mjs'] }) });
    expect(r.reasons).toEqual(['shared-importer:scripts/t.test.mjs (pr:scripts/a.mjs, main:fixtures/z.json)']);
  });
  it('a NON-test shared importer that nothing imports (an entry point CI runs, e.g. check:standards) → affected', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/check-standards.mjs'], 'scripts/z.mjs': ['scripts/check-standards.mjs'] }) });
    expect(r.reasons).toEqual(['shared-importer:scripts/check-standards.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
  });
  it('a middle module is not the meeting point: the entry point above it is', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/mid.mjs'], 'scripts/z.mjs': ['scripts/mid.mjs'], 'scripts/mid.mjs': ['scripts/entry.mjs'] }) });
    expect(r.reasons).toEqual(['shared-importer:scripts/entry.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
  });
  it('a file changed on BOTH sides is not a meeting point (a card both edit: non-code, no importers)', () => {
    const r = run({ prFiles: ['scripts/a.mjs', 'backlog/1-x.md'], mainFiles: ['scripts/z.mjs', 'backlog/1-x.md'], importersOf: () => [] });
    expect(r).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'] });
  });
  it('tests that reach only one side → not affected', () => {
    expect(run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/t1.test.mjs'], 'scripts/z.mjs': ['scripts/t2.test.mjs'] }) }).affected).toBe(false);
  });
  it('an import cycle through the importers terminates', () => {
    const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/b.mjs'], 'scripts/b.mjs': ['scripts/a.mjs'], 'scripts/z.mjs': ['scripts/c.mjs'], 'scripts/c.mjs': ['scripts/z.mjs'] }) });
    expect(r.affected).toBe(false);
  });
  it('unreadable importers fail closed', () => {
    expect(run({ importersOf: () => null }).reasons).toEqual(['importers-unreadable:scripts/a.mjs']);
  });
  it('a caller that supplies no importersOf fails closed rather than skipping the check', () => {
    expect(decideAffectedRule({ prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], importsOf: none }).reasons).toEqual(['importers-unavailable']);
  });
  it('the check runs after the cheap rules: a forward edge is reported as before, importers never asked', () => {
    const importsOf = (side, f) => (side === 'main' && f === 'scripts/z.mjs' ? ['scripts/a.mjs'] : []);
    expect(run({ importsOf, importersOf: () => { throw new Error('not asked'); } }).reasons).toEqual(['main-file-imports-pr-file:scripts/z.mjs->scripts/a.mjs']);
  });
  describe('an entry point inside an import cycle (review round 4: every member has an importer, none is a root)', () => {
    it('an unchanged two-file cycle that reaches both sides is the meeting point CI runs → affected', () => {
      const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/x.mjs'], 'scripts/z.mjs': ['scripts/y.mjs'], 'scripts/x.mjs': ['scripts/y.mjs'], 'scripts/y.mjs': ['scripts/x.mjs'] }) });
      expect(r).toMatchObject({ affected: true, reasons: ['shared-importer:scripts/x.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)'] });
    });
    it('a file that imports itself, run directly, is an entry point', () => {
      const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/s.mjs'], 'scripts/z.mjs': ['scripts/s.mjs'], 'scripts/s.mjs': ['scripts/s.mjs'] }) });
      expect(r.reasons).toEqual(['shared-importer:scripts/s.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
    });
    it('a longer cycle (three files) is still an entry point', () => {
      const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/x.mjs'], 'scripts/z.mjs': ['scripts/x.mjs'], 'scripts/x.mjs': ['scripts/y.mjs'], 'scripts/y.mjs': ['scripts/w.mjs'], 'scripts/w.mjs': ['scripts/x.mjs'] }) });
      expect(r.affected).toBe(true);
    });
    it('a cycle member with an importer OUTSIDE the cycle is a middle module: the entry above it is named', () => {
      const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/x.mjs'], 'scripts/z.mjs': ['scripts/y.mjs'], 'scripts/x.mjs': ['scripts/y.mjs', 'scripts/entry.mjs'], 'scripts/y.mjs': ['scripts/x.mjs'] }) });
      expect(r.reasons).toEqual(['shared-importer:scripts/entry.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
    });
    it('an outside importer the PR itself changes may be dropped by the PR: the file stays an entry point', () => {
      // f is run directly by CI and imports both sides; its only importer at the tip is p, which the PR edits (it may drop `import f`).
      const r = run({ prFiles: ['scripts/a.mjs', 'scripts/p.mjs'], importersOf: importers({ 'scripts/a.mjs': ['scripts/f.mjs'], 'scripts/z.mjs': ['scripts/f.mjs'], 'scripts/f.mjs': ['scripts/p.mjs'] }) });
      expect(r).toMatchObject({ affected: true, reasons: ['shared-importer:scripts/f.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)'] });
    });
    it('a work budget bounds the cycle check and fails closed past it', () => {
      // k files in a closed ring with a spoke each: the walk from any member is O(k); the budget is far below k^2.
      const k = 700;
      const ring = {};
      for (let i = 0; i < k; i++) ring[`scripts/r${i}.mjs`] = [`scripts/r${(i + 1) % k}.mjs`];
      const r = run({ importersOf: importers({ ...ring, 'scripts/a.mjs': ['scripts/r0.mjs'], 'scripts/z.mjs': ['scripts/r1.mjs'] }) });
      expect(r).toMatchObject({ affected: true, reasons: [expect.stringMatching(/^shared-importer:scripts\/r\d+\.mjs /)] });
    });
    it('a cycle that reaches only one side is still not affected', () => {
      const r = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/x.mjs'], 'scripts/x.mjs': ['scripts/y.mjs'], 'scripts/y.mjs': ['scripts/x.mjs'] }) });
      expect(r.affected).toBe(false);
    });
  });
  describe('data read through fs (review round 4: no import edge shows it)', () => {
    const noImporters = (a) => run({ importersOf: () => [], ...a });
    it.each([
      ['main', { mainFiles: ['scripts/z.mjs', 'fixtures/cases.json'] }, 'fixtures/cases.json'],
      ['the PR', { prFiles: ['scripts/a.mjs', 'fixtures/cases.yaml'] }, 'fixtures/cases.yaml'],
    ])('a changed data file on %s that no import reaches → affected', (_side, files, data) => {
      expect(noImporters(files)).toMatchObject({ affected: true, reasons: [`data-file-changed:${data}`] });
    });
    it('other non-source kinds (css, html, images, extensionless) are data too', () => {
      for (const f of ['blocks/x.css', 'site/index.html', 'assets/logo.png', 'scripts/bin/runner']) {
        expect(noImporters({ mainFiles: [f] }).reasons).toEqual([`data-file-changed:${f}`]);
      }
    });
    it('docs and backlog cards stay exempt, as in any-code', () => {
      expect(noImporters({ prFiles: ['scripts/a.mjs', 'backlog/1-x.md'], mainFiles: ['scripts/z.mjs', 'docs/guide.md'] }).affected).toBe(false);
    });
    it('a data file only an import edge reaches keeps its import-graph reason', () => {
      const r = run({ mainFiles: ['fixtures/z.json'], importersOf: importers({ 'scripts/a.mjs': ['scripts/t.test.mjs'], 'fixtures/z.json': ['scripts/t.test.mjs'] }) });
      expect(r.reasons[0]).toMatch(/^shared-importer:/);
    });
    it('unreadable importers still win over the data rule (fail closed under the named reason)', () => {
      expect(run({ mainFiles: ['fixtures/z.json'], importersOf: () => null }).reasons).toEqual(['importers-unreadable:scripts/a.mjs']);
    });
  });
  describe('implicit test infrastructure (review round 2: vitest loads these for every test, no test imports them)', () => {
    it('a PR file that vitest.setup.ts imports, against an unrelated main change → affected', () => {
      const r = run({ prFiles: ['scripts/lib/hermetic-tests.mjs'], mainFiles: ['blocks/renderers/jsx/index.ts'], importersOf: importers({ 'scripts/lib/hermetic-tests.mjs': ['vitest.setup.ts'] }) });
      expect(r).toMatchObject({ affected: true, reasons: ['test-infra-reached:vitest.setup.ts (pr:scripts/lib/hermetic-tests.mjs)'] });
    });
    it('a main-changed file that vitest.config.ts imports, against an unrelated PR → affected', () => {
      const r = run({ prFiles: ['blocks/x.ts'], mainFiles: ['scripts/lib/trust-chain-tier.mjs'], importersOf: importers({ 'scripts/lib/trust-chain-tier.mjs': ['vitest.config.ts'] }) });
      expect(r.reasons).toEqual(['test-infra-reached:vitest.config.ts (main:scripts/lib/trust-chain-tier.mjs)']);
    });
    it('reached through an unchanged hub, and for a suite config or global setup entry', () => {
      const viaHub = run({ importersOf: importers({ 'scripts/a.mjs': ['scripts/hub.mjs'], 'scripts/hub.mjs': ['vitest.globalSetup.mjs'] }) });
      expect(viaHub.reasons).toEqual(['test-infra-reached:vitest.globalSetup.mjs (pr:scripts/a.mjs)']);
      expect(run({ importersOf: importers({ 'scripts/z.mjs': ['vitest.soak.config.ts'] }) }).affected).toBe(true);
    });
    it('a file merely named like the entry (not at the repo root) is not infrastructure', () => {
      expect(run({ importersOf: importers({ 'scripts/a.mjs': ['docs/vitest.setup.ts'] }) }).affected).toBe(false);
    });
  });
});

describe('readAffectedFacts — shared unchanged importer through git (one batched read of the tip tree)', () => {
  const HEAD = 'h'.repeat(40);
  const TIP = 't'.repeat(40);
  const trees = () => ({
    [HEAD]: { 'scripts/a.mjs': 'export const a = 2;' },
    [TIP]: {
      'scripts/a.mjs': 'export const a = 1;', 'scripts/z.mjs': 'export const z = 2;', 'scripts/other.mjs': '',
      'scripts/__tests__/t.test.mjs': "import { a } from '../a.mjs';\nimport { z } from '../z.mjs';",
    },
  });
  const facts = (extra = {}) => ({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['scripts/z.mjs'], ...extra });
  it('an unchanged test importing both a PR file and a main file → affected, with the test named', () => {
    const { git } = fakeGit(trees());
    expect(readAffectedFacts({ ...facts(), git }).reasons).toEqual(['shared-importer:scripts/__tests__/t.test.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
  });
  it('an unchanged test that READS a main-changed data file through fs (no import) → affected through git', () => {
    const t = trees();
    t[TIP]['scripts/__tests__/reader.test.mjs'] = "import { a } from '../a.mjs';\nconst rows = JSON.parse(readFileSync(new URL('../../fixtures/cases.json', import.meta.url)));";
    t[TIP]['fixtures/cases.json'] = '[2]';
    delete t[TIP]['scripts/__tests__/t.test.mjs'];
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts({ mainFiles: ['scripts/z.mjs', 'fixtures/cases.json'] }), git }).reasons).toEqual(['data-file-changed:fixtures/cases.json']);
  });
  it('an import cycle of unchanged files that reaches both sides → affected through git', () => {
    const t = trees();
    delete t[TIP]['scripts/__tests__/t.test.mjs'];
    t[TIP]['scripts/x.mjs'] = "import { a } from './a.mjs';\nimport { y } from './y.mjs';";
    t[TIP]['scripts/y.mjs'] = "import { z } from './z.mjs';\nimport { x } from './x.mjs';";
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts(), git }).reasons).toEqual(['shared-importer:scripts/x.mjs (pr:scripts/a.mjs, main:scripts/z.mjs)']);
  });
  it('the same tree without that test → not affected', () => {
    const t = trees();
    delete t[TIP]['scripts/__tests__/t.test.mjs'];
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts(), git })).toMatchObject({ affected: false, reasons: ['main-delta-unaffected'] });
  });
  it('the whole tip tree is read in ONE git spawn, and a second PR against the same tip reuses it', () => {
    const t = trees();
    t[TIP]['scripts/__tests__/u.test.mjs'] = "import './other.mjs';";
    const { git, calls } = fakeGit(t);
    const tipGraphCache = new Map();
    readAffectedFacts({ ...facts(), git, tipGraphCache });
    readAffectedFacts({ ...facts({ prFiles: ['scripts/other.mjs'] }), git, tipGraphCache });
    expect(calls.filter((c) => c === 'cat-file --batch')).toHaveLength(1);
  });
  it('a test whose path has a non-ASCII character is still seen (ls-tree -z, not git\'s quoted spelling)', () => {
    const t = trees();
    delete t[TIP]['scripts/__tests__/t.test.mjs'];
    t[TIP]['scripts/__tests__/café.test.mjs'] = "import '../a.mjs';\nimport '../z.mjs';";
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts(), git }).reasons[0]).toMatch(/^shared-importer:scripts\/__tests__\/café\.test\.mjs /);
  });
  it('a file the PR ADDS that an unchanged test already names by a specifier resolving to nothing (a guarded dynamic import) → affected', () => {
    const t = trees();
    t[TIP]['scripts/lib/t.test.mjs'] = "import { z } from '../z.mjs';\nawait import('./plugins/extra.mjs').catch(() => {});";
    t[HEAD]['scripts/lib/plugins/extra.mjs'] = 'export const extra = 1;';
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts({ prFiles: ['scripts/lib/plugins/extra.mjs'] }), git }).reasons)
      .toEqual(['shared-importer:scripts/lib/t.test.mjs (pr:scripts/lib/plugins/extra.mjs, main:scripts/z.mjs)']);
  });
  it('a file the PR adds that SHADOWS the one a test resolves today (`./foo` → foo.js, PR adds foo.mjs; `./dir` → dir/index.mjs) → affected', () => {
    for (const [existing, added, spec] of [['scripts/foo.js', 'scripts/foo.mjs', '../foo'], ['scripts/dir.js', 'scripts/dir/index.mjs', '../dir']]) {
      const t = trees();
      t[TIP][existing] = '';
      t[TIP]['scripts/__tests__/t.test.mjs'] = `import '${spec}';\nimport '../z.mjs';`;
      t[HEAD][added] = '';
      const { git } = fakeGit(t);
      expect(readAffectedFacts({ ...facts({ prFiles: [added] }), git }).reasons[0]).toMatch(/^shared-importer:scripts\/__tests__\/t\.test\.mjs /);
    }
  });
  it('a file the PR adds that nothing names stays unaffected (the added-file rule is not a blanket refresh)', () => {
    const { git } = fakeGit(trees());
    expect(readAffectedFacts({ ...facts({ prFiles: ['scripts/brand-new.mjs'] }), git }).affected).toBe(false);
  });
  it('a tracked source path holding a newline would desync the batched read: fails closed under a named reason', () => {
    const t = trees();
    t[TIP]['scripts/evil\nname.mjs'] = '';
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts(), git }).reasons).toEqual(['reverse-graph-unreadable:newline-in-path']);
  });
  it('a failed tip-graph read is remembered for that tip: the next PR of the pass does not re-spawn it', () => {
    const { git, calls } = fakeGit(trees(), { batchFails: true });
    const tipGraphCache = new Map();
    const a = readAffectedFacts({ ...facts(), git, tipGraphCache });
    const b = readAffectedFacts({ ...facts({ prFiles: ['scripts/other.mjs'] }), git, tipGraphCache });
    expect([a.reasons, b.reasons]).toEqual([['reverse-graph-unreadable:ENOBUFS'], ['reverse-graph-unreadable:ENOBUFS']]);
    expect(calls.filter((c) => c === 'cat-file --batch')).toHaveLength(1);
  });
  it('a tip graph that cannot be read in full fails closed under a NAMED reason, never unaffected', () => {
    const { git } = fakeGit(trees(), { batchFails: true });
    expect(readAffectedFacts({ ...facts(), git }).reasons).toEqual(['reverse-graph-unreadable:ENOBUFS']);
  });
  it('a tip tree with more source files than the cap fails closed (reverse-graph-too-large)', () => {
    const t = trees();
    for (let i = 0; i < 12; i++) t[TIP][`scripts/lib/pad${i}.mjs`] = '';
    const { git } = fakeGit(t);
    expect(readAffectedFacts({ ...facts(), git, maxReverseFiles: 10 }).reasons).toEqual(['reverse-graph-too-large']);
  });
  it('a blob git reports missing mid-batch fails closed (reverse-graph-unreadable), not "imports nothing"', () => {
    const { git } = fakeGit(trees());
    const g = (args, opts) => (args[1] === '--batch' ? Buffer.from(`${TIP}:scripts/a.mjs missing\n`) : git(args, opts));
    expect(readAffectedFacts({ ...facts(), git: g }).reasons[0]).toMatch(/^reverse-graph-unreadable:/);
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
  it('a gate-editing PR with an OLD pass and a docs-only main move is not excused: the verdict is affected, so age still counts (round 5)', () => {
    const v = readAffectedFacts({ headSha: 'h', tipSha: 't', prFiles: ['scripts/lib/merge-queue-affected.mjs'], mainFiles: ['docs/x.md'], git: () => { throw new Error('no git'); } });
    expect(v).toMatchObject({ affected: true, reasons: ['gate-touched:scripts/lib/merge-queue-affected.mjs'] });
    const f = facts(v, 120);
    f.main.filesChangedSinceBase = ['docs/x.md'];
    f.pr.files = ['scripts/lib/merge-queue-affected.mjs'];
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: f, nowMs: now, settings: LIVE }).action).toBe('refresh');
    // round 6: the same old pass on a non-gate PR is refreshed too — the no-code shortcut read no graph, so it excuses
    // only what any-code excuses (a disjoint prose move inside the age window), never the pass's age
    const old = facts({ affected: false, reasons: ['main-gained-no-code'], mainCodeFiles: 0 }, 120);
    old.main.filesChangedSinceBase = ['docs/x.md'];
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: old, nowMs: now, settings: LIVE }).action).toBe('refresh');
    // and a young pass against that prose-only move still merges, as in any-code
    const young = facts({ affected: false, reasons: ['main-gained-no-code'], mainCodeFiles: 0 }, 5);
    young.main.filesChangedSinceBase = ['docs/x.md'];
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: young, nowMs: now, settings: LIVE }).action).toBe('merge');
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

// Review round 6 (rung 2): `nonCodePaths` exempted EVERY file under docs/ and backlog/, executable code included, so the
// `main-gained-no-code` early return (and the hook's own `mainGainedCode`) excused a main move a PR file imports. The
// exemption now covers prose only (Markdown, text); any other file there is code or data, judged like one anywhere else.
describe('the non-code exemption covers prose only (review round 6: the no-code early return)', () => {
  const HEAD = 'h'.repeat(40);
  const TIP = 't'.repeat(40);
  it.each([['docs/tool.mjs'], ['docs/data.json']])('main changed only %s, which a PR file imports → affected, not main-gained-no-code', (target) => {
    const importsOf = (side, f) => (side === 'pr' && f === 'scripts/a.mjs' ? [target] : []);
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: [target], importsOf }))
      .toMatchObject({ affected: true, reasons: [`pr-file-imports-main-file:scripts/a.mjs->${target}`], mainCodeFiles: 1 });
  });
  it('a source file main changed under backlog/ is code too (backlog/ is also a scanned fixture root → glob-edge)', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['backlog/tools/x.ts'], importsOf: none }))
      .toMatchObject({ affected: true, reasons: ['glob-edge:backlog/tools/x.ts'], mainCodeFiles: 1 });
  });
  it('a docs/ source file main changed that reaches a PR file through an unchanged module → affected (it is a root)', () => {
    const importsOf = (side, f) => (side === 'main' && f === 'docs/tool.mjs' ? ['scripts/mid.mjs'] : side === 'main' && f === 'scripts/mid.mjs' ? ['scripts/a.mjs'] : []);
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/tool.mjs'], importsOf }).reasons)
      .toEqual(['main-file-imports-pr-file:docs/tool.mjs->scripts/mid.mjs->scripts/a.mjs']);
  });
  it('an unchanged test importing a PR file and a docs/ source file main changed → shared-importer', () => {
    const importersOf = (f) => (f === 'scripts/a.mjs' || f === 'docs/tool.mjs' ? ['scripts/__tests__/t.test.mjs'] : []);
    expect(decideAffectedRule({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/tool.mjs'], importsOf: none, importersOf }).reasons)
      .toEqual(['shared-importer:scripts/__tests__/t.test.mjs (pr:scripts/a.mjs, main:docs/tool.mjs)']);
  });
  it('a data file under docs/ that no import reaches is data read through fs, not prose → data-file-changed', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/fixtures/cases.json'], importsOf: none }).reasons).toEqual(['data-file-changed:docs/fixtures/cases.json']);
  });
  it('a gate file under a configured nonCodePaths entry still trips the gate rule (the gate is checked on every main file)', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['.github/workflows/ci.yml'], nonCodePaths: ['docs/', '.github/'], importsOf: none }))
      .toMatchObject({ affected: true, reasons: ['gate-touched:.github/workflows/ci.yml'] });
  });
  it('prose under docs/ and backlog/ still takes the no-IO shortcut', () => {
    const git = () => { throw new Error('no IO expected'); };
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/x.md', 'backlog/1-x.md', 'docs/notes.txt'], git }).reasons).toEqual(['main-gained-no-code']);
  });
  it('through git: main changed only docs/tool.mjs, the PR file imports it → affected (the shortcut no longer skips the read)', () => {
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import { t } from '../docs/tool.mjs';", 'docs/tool.mjs': 'export const t = 1;' },
      [TIP]: { 'scripts/a.mjs': '', 'docs/tool.mjs': 'export const t = 2;' },
    });
    expect(readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/tool.mjs'], git }))
      .toMatchObject({ affected: true, reasons: ['pr-file-imports-main-file:scripts/a.mjs->docs/tool.mjs'] });
  });
  it('end to end: a FRESH pass whose main move is only docs/tool.mjs (which the PR imports) is refreshed, not merged', () => {
    const LIVE = loadMergeQueueSettings({ file: JSON.parse(readFileSync(join(SETTINGS_DIR, 'merge-queue.json'), 'utf8')), env: {} });
    const now = Date.parse('2026-10-10T14:00:00Z');
    const { git } = fakeGit({
      [HEAD]: { 'scripts/a.mjs': "import { t } from '../docs/tool.mjs';", 'docs/tool.mjs': 'export const t = 1;' },
      [TIP]: { 'scripts/a.mjs': '', 'docs/tool.mjs': 'export const t = 2;' },
    });
    const affected = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/tool.mjs'], git });
    const facts = {
      pr: { headSha: HEAD, baseSha: 'b', files: ['scripts/a.mjs'], filesComplete: true,
        requiredCheck: { state: 'passed', headSha: HEAD, completedAtMs: now - 5 * 60_000, runId: '1', checkRunId: 1 } },
      main: { tipSha: TIP, commitsSinceBase: 1, filesChangedSinceBase: ['docs/tool.mjs'], complete: true },
      errors: [], affected,
    };
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts, nowMs: now, settings: LIVE }).action).toBe('refresh');
    // the same fresh pass against a prose-only main move still merges (the speed-up for docs/backlog moves stays)
    const prose = { ...facts, main: { ...facts.main, filesChangedSinceBase: ['docs/x.md'] }, affected: readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['docs/x.md'], git }) };
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: prose, nowMs: now, settings: LIVE }).action).toBe('merge');
  });
  // The no-code shortcut never reads the graph, so it proves nothing about a PR file that reads changed prose (fs, `?raw`).
  // It therefore excuses exactly what any-code excuses — a disjoint move inside the age window — and never the pass's age.
  it('an OLD pass against a prose-only main move is refreshed for age (the no-code shortcut walked no graph: any-code parity)', () => {
    const LIVE = loadMergeQueueSettings({ file: JSON.parse(readFileSync(join(SETTINGS_DIR, 'merge-queue.json'), 'utf8')), env: {} });
    const now = Date.parse('2026-10-10T14:00:00Z');
    const affected = readAffectedFacts({ headSha: HEAD, tipSha: TIP, prFiles: ['scripts/a.mjs'], mainFiles: ['backlog/9999-new-card.md'], git: () => { throw new Error('no git'); } });
    expect(affected).toMatchObject({ affected: false, reasons: ['main-gained-no-code'] });
    const facts = (ageMin) => ({
      pr: { headSha: HEAD, baseSha: 'b', files: ['scripts/a.mjs'], filesComplete: true,
        requiredCheck: { state: 'passed', headSha: HEAD, completedAtMs: now - ageMin * 60_000, runId: '1', checkRunId: 1 } },
      main: { tipSha: TIP, commitsSinceBase: 1, filesChangedSinceBase: ['backlog/9999-new-card.md'], complete: true },
      errors: [], affected,
    });
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(180), nowMs: now, settings: LIVE }))
      .toMatchObject({ action: 'refresh', reasons: expect.arrayContaining(['pass-too-old']) });
    expect(decideMergeQueueAction({ key: 'k', num: 1, facts: facts(5), nowMs: now, settings: LIVE }).action).toBe('merge');
  });
  it('`.mdx` is not prose: it compiles to JSX and can import modules', () => {
    expect(decideAffected({ prFiles: ['scripts/a.mjs'], mainFiles: ['docs/page.mdx'], importsOf: none }).reasons).toEqual(['data-file-changed:docs/page.mdx']);
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
