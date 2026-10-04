/**
 * @file scope-reconcile.test.mjs — proof for WE #2803 (resolve-time scope reconciliation), in two halves:
 *
 *   1. The PURE core (`../scope-reconcile.mjs` `reconcileScope`) on injected arrays — no fs, no git.
 *   2. The CLI WIRING in `scripts/backlog.mjs`'s `resolve` verb, on a REAL subprocess against a throwaway
 *      clone. The #2274 substrate (`mkdtemp` + `cpSync scripts/`) is NOT sufficient on its own here: it never
 *      runs `git init`, so `observedFilesForResolve()` would degrade to `[]` and every offending-file row
 *      would pass VACUOUSLY. So the clone is git-initialised with one commit, an `origin` remote whose slug
 *      maps to the `we` repo key, and an `origin/main` ref — then a presentation file is written on top, which
 *      is exactly the shape the guard must refuse.
 *
 * Both halves live in one file because #2803's declared `scope:` names exactly one test file.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcileScope } from '../scope-reconcile.mjs';
import { ROUTE_ENTRIES } from '../../lib/route-import-graph.mjs';

// ── 1. the pure core ────────────────────────────────────────────────────────────────────────────────────────

describe('reconcileScope — the pure core (#2803)', () => {
  it('an undeclared PRESENTATION file is offending, and the reconciliation is not clean', () => {
    const r = reconcileScope({
      declared: ['we:scripts/foo.mjs'],
      observed: ['we:scripts/foo.mjs', 'we:src/_includes/x.njk'],
    });
    expect(r.offending).toEqual(['we:src/_includes/x.njk']);
    expect(r.clean).toBe(false);
  });

  it('a declared SUBTREE covers a file beneath it (the coversFile granularity contract, not a re-impl)', () => {
    const r = reconcileScope({ declared: ['we:src/_includes/'], observed: ['we:src/_includes/x.njk'] });
    expect(r.undeclared).toEqual([]);
    expect(r.offending).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it('an undeclared NON-presentation file is returned in `undeclared` but is neither offending nor fatal (Fork D)', () => {
    const r = reconcileScope({
      declared: ['we:scripts/foo.mjs'],
      observed: ['we:scripts/foo.mjs', 'we:scripts/readiness/other.mjs', 'we:docs/agent/x.md'],
    });
    expect(r.undeclared).toEqual(['we:scripts/readiness/other.mjs', 'we:docs/agent/x.md']);
    expect(r.offending).toEqual([]);
    expect(r.clean).toBe(true);
  });

  it('a routeGraph entry module in the undeclared set IS offending — the route-graph half is wired', () => {
    const entry = ROUTE_ENTRIES['/console-board'][1]; // plateau-app:src/backlog-view/lane-board-data.ts
    const observed = ['we:scripts/foo.mjs', entry];
    // Without a routeGraph only the path-regex half runs, and a `.ts` data module matches nothing.
    expect(reconcileScope({ declared: ['we:scripts/foo.mjs'], observed }).offending).toEqual([]);
    // With it, the same file is caught.
    const r = reconcileScope({
      declared: ['we:scripts/foo.mjs'],
      observed,
      routeGraph: { routeEntries: ROUTE_ENTRIES },
    });
    expect(r.offending).toEqual([entry]);
    expect(r.clean).toBe(false);
  });

  it('empty / absent inputs are clean, never a throw', () => {
    expect(reconcileScope({ declared: [], observed: [] })).toEqual({ undeclared: [], offending: [], clean: true });
    expect(reconcileScope({}).clean).toBe(true);
    expect(reconcileScope().clean).toBe(true);
    // An empty observed set (the drain's synced-clone shape) always passes — the guard is inert there by design.
    expect(reconcileScope({ declared: ['we:scripts/foo.mjs'], observed: [] }).clean).toBe(true);
  });
});

// ── 2. the CLI wiring — a git-initialised throwaway clone ───────────────────────────────────────────────────

// this file is scripts/readiness/__tests__/* → three levels up is .../scripts
const WE_SCRIPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WE_ROOT = resolve(WE_SCRIPTS_DIR, '..');

let clone;
const git = (args, cwd = clone) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

beforeAll(() => {
  clone = mkdtempSync(join(tmpdir(), 'we-scope-reconcile-'));
  cpSync(WE_SCRIPTS_DIR, join(clone, 'scripts'), { recursive: true });
  // backlog.mjs reads `scope:` through gray-matter via createRequire — resolution walks up from
  // <clone>/scripts, so the clone needs a node_modules to find it. We resolve `gray-matter`'s REAL
  // install location via this process's OWN module resolution (`createRequire(...).resolve(...)`)
  // rather than assuming `WE_ROOT/node_modules` is populated: a harness-sandboxed Claude Code agent
  // worktree (`.claude/worktrees/agent-*`, created by the `isolation: "worktree"` mechanism) can have
  // an absent or stray near-empty `node_modules` of its own, since nothing ever ran `npm install`
  // there — CI and every normal checkout always run `npm ci` first, so this only bites a worktree that
  // never got one. Resolving via `createRequire` walks up the directory tree exactly the way the
  // running test process itself resolves `gray-matter` (and the way Node's own `require` would from
  // `<clone>/scripts`), so it always lands on wherever `gray-matter` truly lives — it can never point
  // at an empty/nonexistent directory the way `WE_ROOT/node_modules` could.
  const grayMatterEntry = createRequire(import.meta.url).resolve('gray-matter');
  const grayMatterNodeModules = grayMatterEntry.slice(0, grayMatterEntry.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length);
  symlinkSync(grayMatterNodeModules, join(clone, 'node_modules'), 'dir');
  mkdirSync(join(clone, '.claude', 'skills', 'batch-backlog-items'), { recursive: true });
  mkdirSync(join(clone, 'backlog'), { recursive: true });
  // `src/_includes/` must be TRACKED before the per-test presentation file is written into it: plain
  // `git status --porcelain` (what `observedFilesForResolve` runs, matching scope-lease-collect) collapses a
  // WHOLLY-untracked directory to a single `?? src/` line, and the individual `.njk` would never be observed.
  // A real lane clone always has these directories tracked, so tracking them here is fidelity, not a dodge.
  mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
  writeFileSync(join(clone, 'src', '_includes', '.gitkeep'), '');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  // The origin slug is what `repoKeyFromSlug` turns into the `we:` qualifier the declared scope is matched on.
  git(['remote', 'add', 'origin', 'https://github.com/web-everything/web-everything.git']);
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  // The diff base. merge-base(origin/main, HEAD) == HEAD, so the COMMITTED half is empty and the observed set
  // is exactly the dirty tree written per-test below.
  git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD']).trim()]);
});
afterAll(() => { try { rmSync(clone, { recursive: true, force: true }); } catch { /* best-effort */ } });

const write = (rel, content) => writeFileSync(join(clone, rel), content);
const read = (rel) => readFileSync(join(clone, rel), 'utf8');
const item = (fields, body = '# Title\n\nPlain body, no code refs.\n') =>
  `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;

/** The item shape the guard is written for: active, with a NON-presentation declared scope. */
const scopedItem = () => item({
  kind: 'story', size: 2, status: 'active', dateOpened: '"2026-08-01"', dateStarted: '"2026-08-01"',
  scope: '\n  - "we:scripts/foo.mjs"',
});

/** `spawnSync`, not `execFileSync`: the guard's notes and warnings go to STDERR, and the success path of
 *  `execFileSync` returns stdout only. */
function runIn(cwd, args) {
  const r = spawnSync('node', [join(cwd, 'scripts', 'backlog.mjs'), ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const run = (args) => runIn(clone, args);

/** Reset the dirty tree between rows so each one observes only what it writes. */
const cleanTree = () => {
  try { git(['checkout', '--', '.']); } catch { /* nothing tracked-dirty */ }
  git(['clean', '-qfd', '--', 'backlog', 'src', 'scripts']);
  mkdirSync(join(clone, 'backlog'), { recursive: true });
  mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
};

describe('backlog.mjs resolve — the #2803 guard, wired (CLI)', () => {
  it('refuses the resolve and leaves status: active when an undeclared PRESENTATION file is in the diff', () => {
    cleanTree();
    write('backlog/8200-under-scoped.md', scopedItem());
    mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
    write('src/_includes/leaked.njk', '<p>ui</p>\n');
    const res = run(['resolve', '8200']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toMatch(/we:src\/_includes\/leaked\.njk/);
    expect(res.stderr).toMatch(/#2803/);
    // The contradiction was never written to disk.
    expect(read('backlog/8200-under-scoped.md')).toMatch(/^status: active$/m);
  });

  it('the undeclared NON-presentation files in the same diff are NOT named on stderr (Fork D)', () => {
    // The item file itself is dirty + undeclared, and so is this extra script — neither may be printed.
    cleanTree();
    write('backlog/8200-under-scoped.md', scopedItem());
    mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
    write('src/_includes/leaked.njk', '<p>ui</p>\n');
    write('scripts/drift-not-declared.mjs', 'export const x = 1;\n');
    const res = run(['resolve', '8200']);
    expect(res.code).not.toBe(0);
    expect(res.stderr).not.toMatch(/drift-not-declared/);
    expect(res.stderr).not.toMatch(/8200-under-scoped\.md/);
    rmSync(join(clone, 'scripts', 'drift-not-declared.mjs'), { force: true });
  });

  it('--force resolves anyway and warns, naming each offending file', () => {
    cleanTree();
    write('backlog/8201-forced.md', scopedItem());
    mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
    write('src/_includes/leaked.njk', '<p>ui</p>\n');
    const res = run(['resolve', '8201', '--force']);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/--force/);
    expect(res.stderr).toMatch(/we:src\/_includes\/leaked\.njk/);
    expect(read('backlog/8201-forced.md')).toMatch(/^status: resolved$/m);
  });

  it('an item with NO scope: resolves normally and prints the Fork-C note', () => {
    cleanTree();
    write('backlog/8202-legacy.md', item({ kind: 'story', size: 2, status: 'active', dateOpened: '"2026-08-01"', dateStarted: '"2026-08-01"' }));
    mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
    write('src/_includes/leaked.njk', '<p>ui</p>\n');
    const res = run(['resolve', '8202']);
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/declares no scope:/);
    expect(read('backlog/8202-legacy.md')).toMatch(/^status: resolved$/m);
  });

  it('a DECLARED presentation file resolves cleanly — the guard only fires on what was never declared', () => {
    cleanTree();
    write('backlog/8203-declared-ui.md', item({
      kind: 'story', size: 2, status: 'active', dateOpened: '"2026-08-01"', dateStarted: '"2026-08-01"',
      scope: '\n  - "we:src/_includes/declared.njk"',
    }));
    mkdirSync(join(clone, 'src', '_includes'), { recursive: true });
    write('src/_includes/declared.njk', '<p>ui</p>\n');
    const res = run(['resolve', '8203']);
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/#2803/);
    expect(read('backlog/8203-declared-ui.md')).toMatch(/^status: resolved$/m);
  });

  it('degrades to a note (never a failure) when the clone has no readable git state', () => {
    // A throwaway dir with the scripts tree but NO git repo — `observedFilesForResolve` must return [] with a
    // printed note and the resolve must still succeed. This is the row that proves a git hiccup can never
    // block a resolve (and, incidentally, why the fixture above must be git-initialised to mean anything).
    const bare = mkdtempSync(join(tmpdir(), 'we-scope-reconcile-nogit-'));
    try {
      cpSync(join(clone, 'scripts'), join(bare, 'scripts'), { recursive: true });
      symlinkSync(join(WE_ROOT, 'node_modules'), join(bare, 'node_modules'), 'dir');
      mkdirSync(join(bare, '.claude', 'skills', 'batch-backlog-items'), { recursive: true });
      mkdirSync(join(bare, 'backlog'), { recursive: true });
      writeFileSync(join(bare, 'backlog', '8204-nogit.md'), scopedItem());
      mkdirSync(join(bare, 'src', '_includes'), { recursive: true });
      writeFileSync(join(bare, 'src', '_includes', 'leaked.njk'), '<p>ui</p>\n');
      const res = runIn(bare, ['resolve', '8204']);
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/could not be read/);
      expect(readFileSync(join(bare, 'backlog', '8204-nogit.md'), 'utf8')).toMatch(/^status: resolved$/m);
    } finally {
      try { rmSync(bare, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
