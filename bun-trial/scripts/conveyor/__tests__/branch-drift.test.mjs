/**
 * @file scripts/conveyor/__tests__/branch-drift.test.mjs
 * @description Proof for the #3464 branch-drift reconciliation cadence, in two halves:
 *
 *   1. The PURE core ({@link classifyBranchDrift}, {@link parseLeftRightCount}) on injected values — no git.
 *   2. The IO CLI (`sweep` / `check`) against REAL throwaway git fixtures (mirroring `scope-reconcile.test.mjs`'s
 *      own `mkdtemp` + real `git init` pattern) — including the item's own Done-when #2 regression shape: two
 *      fixture branches whose INDIVIDUAL commits each look disjoint-scoped, but that collide once reconciled.
 *      This proves the sweep surfaces drift/conflict state from a git note any fresh clone can read back, with
 *      no human running `git log`/`git rev-list` by hand.
 */
import { describe, it, test, expect, beforeAll, afterAll } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/conveyor/__tests__/branch-drift.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBranchDrift, parseLeftRightCount, DEFAULT_MAX_BEHIND } from '../../../../scripts/conveyor/branch-drift.mjs';

const HERE = dirname(fileURLToPath(__ORIG_URL));
const DRIFT_CLI = resolve(HERE, '..', 'branch-drift.mjs');

// ── 1. the pure core ─────────────────────────────────────────────────────────────────────────────────────────

describe('classifyBranchDrift — the pure core (#3464)', () => {
  it('few commits behind, no conflict → ok', () => {
    expect(classifyBranchDrift({ ahead: 2, behind: 3, conflict: false })).toEqual({ status: 'ok', reason: null });
  });

  it('past half the ceiling but not past it → watch', () => {
    const r = classifyBranchDrift({ ahead: 0, behind: 25, conflict: false, maxBehind: 40 });
    expect(r.status).toBe('watch');
    expect(r.reason).toMatch(/25 commits behind/);
  });

  it('past the ceiling → blocked, regardless of conflict', () => {
    const r = classifyBranchDrift({ ahead: 0, behind: 78, conflict: false, maxBehind: 40 });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/78 commits behind \(ceiling 40\)/);
  });

  it('a dry-run merge conflict → blocked even well under the ceiling', () => {
    const r = classifyBranchDrift({ ahead: 1, behind: 2, conflict: true, maxBehind: 40 });
    expect(r.status).toBe('blocked');
    expect(r.reason).toMatch(/conflicts/);
  });

  it('defaults maxBehind when omitted/invalid', () => {
    expect(classifyBranchDrift({ behind: DEFAULT_MAX_BEHIND + 1 }).status).toBe('blocked');
    expect(classifyBranchDrift({ behind: 1, maxBehind: 0 }).status).toBe('ok');
  });
});

describe('parseLeftRightCount — the pure core', () => {
  it('parses "<behind>\\t<ahead>" into {behind, ahead}', () => {
    expect(parseLeftRightCount('78\t29')).toEqual({ behind: 78, ahead: 29 });
    expect(parseLeftRightCount('0\t0\n')).toEqual({ behind: 0, ahead: 0 });
  });

  it('unparseable input fails toward nothing-to-report, not a throw', () => {
    expect(parseLeftRightCount('')).toEqual({ ahead: 0, behind: 0 });
    expect(parseLeftRightCount('garbage')).toEqual({ ahead: 0, behind: 0 });
  });
});

// ── 2. the IO CLI — real throwaway git fixtures, no network ────────────────────────────────────────────────

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const runSweep = (cwd, extra = []) =>
  execFileSync('node', [DRIFT_CLI, 'sweep', '--no-fetch', '--json', ...extra], { cwd, encoding: 'utf8' });
const runCheck = (cwd, extra = []) =>
  execFileSync('node', [DRIFT_CLI, 'check', '--no-fetch', '--json', ...extra], { cwd, encoding: 'utf8' });

let root;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'we-branch-drift-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Build one throwaway constellation: a bare `origin`, a `main` line of `mainCommits` commits, and a
 *  `feature`-named long-lived branch forked at the common ancestor with `branchCommits` commits — everything
 *  pushed to `origin` so a fresh clone (no working copy at all) can `sweep`/`check` it, exactly as a real
 *  scratch checkout would against `origin/lane/mechanical-dispatcher`. Returns the clone dir to run the CLI in. */
function buildFixture(name, { mainCommits, branchCommits }) {
  const dir = join(root, name);
  const bare = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  mkdirSync(bare, { recursive: true });
  git(['init', '-q', '--bare'], bare);
  mkdirSync(seed, { recursive: true });
  git(['init', '-q'], seed);
  git(['config', 'user.email', 'test@example.com'], seed);
  git(['config', 'user.name', 'Test'], seed);
  git(['remote', 'add', 'origin', bare], seed);
  writeFileSync(join(seed, 'shared.txt'), 'base\n');
  git(['add', 'shared.txt'], seed);
  git(['commit', '-q', '-m', 'seed'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  git(['checkout', '-q', '-b', 'feature', 'main'], seed);
  git(['push', '-q', 'origin', 'feature'], seed);

  for (const [branch, count, prefix] of [['main', mainCommits, 'm'], ['feature', branchCommits, 'f']]) {
    git(['checkout', '-q', branch], seed);
    for (let i = 0; i < count.n; i += 1) {
      writeFileSync(join(seed, `${prefix}${i}.txt`), `${prefix}${i}\n`);
      git(['add', `${prefix}${i}.txt`], seed);
      git(['commit', '-q', '-m', `${branch} #${i}`], seed);
    }
    if (count.editSharedTo != null) {
      writeFileSync(join(seed, 'shared.txt'), `${count.editSharedTo}\n`);
      git(['add', 'shared.txt'], seed);
      git(['commit', '-q', '-m', `${branch} edits shared.txt`], seed);
    }
    git(['push', '-q', 'origin', branch], seed);
  }

  const clone = join(dir, 'clone');
  git(['clone', '-q', bare, clone]);
  git(['config', 'user.email', 'test@example.com'], clone);
  git(['config', 'user.name', 'Test'], clone);
  return { dir, bare, clone };
}

describe('branch-drift.mjs sweep/check — real fixture repos, no network (#3464)', () => {
  it('a handful of commits behind, disjoint files → ok, and check reads the same verdict back', () => {
    const { clone } = buildFixture('ok', { mainCommits: { n: 3 }, branchCommits: { n: 1 } });
    const sweep = JSON.parse(runSweep(clone, ['--branch=feature', '--target=main']));
    expect(sweep.status).toBe('ok');
    expect(sweep.behind).toBe(3);
    expect(sweep.conflict).toBe(false);
    expect(sweep.noted).toBe(true);

    const check = JSON.parse(runCheck(clone, ['--branch=feature', '--target=main']));
    expect(check.status).toBe('ok');
  });

  it('past the commit-count ceiling (mirrors the real 78-behind incident) → blocked, even with zero content conflict', () => {
    const { clone } = buildFixture('ceiling', { mainCommits: { n: DEFAULT_MAX_BEHIND + 5 }, branchCommits: { n: 1 } });
    const sweep = JSON.parse(runSweep(clone, ['--branch=feature', '--target=main', `--max-behind=${DEFAULT_MAX_BEHIND}`]));
    expect(sweep.status).toBe('blocked');
    expect(sweep.behind).toBe(DEFAULT_MAX_BEHIND + 5);
    expect(sweep.conflict).toBe(false);
    expect(sweep.reason).toMatch(/ceiling/);
  });

  it('independently in-scope, disjoint-per-commit changes that collide once reconciled → blocked (dry-run conflict), and a FRESH clone with no history of the sweep can read the report back', () => {
    // Both sides' own commits touch DIFFERENT files (m0.txt / f0.txt) — individually each looks disjoint and
    // in-scope — but BOTH ALSO edit the shared file, on the SAME line, to DIFFERENT content: exactly #3464's
    // own incident shape (four files independently in-scope on each side, but colliding once merged).
    const { bare, clone } = buildFixture('conflict', {
      mainCommits: { n: 1, editSharedTo: 'main-version' },
      branchCommits: { n: 1, editSharedTo: 'branch-version' },
    });
    const sweep = JSON.parse(runSweep(clone, ['--branch=feature', '--target=main']));
    expect(sweep.status).toBe('blocked');
    expect(sweep.conflict).toBe(true);
    expect(sweep.reason).toMatch(/conflicts/);
    expect(sweep.noted).toBe(true);
    expect(sweep.pushed).toBe(true); // pushed to the bare "origin" — durable past this clone's own lifetime

    // A SECOND, independently-cloned checkout — standing in for a fresh scratch clone that never ran the sweep
    // itself and whose plain `git clone` did NOT bring in `refs/notes/*` (git clone never fetches notes by
    // default) — reads the SAME verdict back purely off a `check` that fetches the notes ref itself, with no
    // git-log archaeology by a human.
    const freshClone = join(root, 'conflict-fresh-clone');
    git(['clone', '-q', bare, freshClone]);
    git(['config', 'user.email', 'test@example.com'], freshClone);
    git(['config', 'user.name', 'Test'], freshClone);
    const check = JSON.parse(
      execFileSync('node', [DRIFT_CLI, 'check', '--json', '--branch=feature', '--target=main'], { cwd: freshClone, encoding: 'utf8' }),
    );
    expect(check.status).toBe('blocked');
    expect(check.conflict).toBe(true);
  });

  it('check on a branch with no report yet fails OPEN (unknown, never blocked)', () => {
    const { clone } = buildFixture('no-report', { mainCommits: { n: 1 }, branchCommits: { n: 1 } });
    const check = JSON.parse(runCheck(clone, ['--branch=feature', '--target=main']));
    expect(check.status).toBe('unknown');
  });

  it('a SECOND, independently-cloned checkout can still publish its own sweep after a FIRST clone already pushed a report — the notes push must not be a plain (non-force) push', () => {
    // Reproduces the exact failure mode a plain `git push origin <notesRef>` (no force) hits: clone A sweeps
    // first and pushes a note. A fresh clone B has an EMPTY local notes ref (plain `git clone` never fetches
    // `refs/notes/*`), so B's own `notes add` builds a note commit with NO parent — not a fast-forward
    // descendant of what A already pushed. A non-force push of that would be rejected by the remote, and a
    // caught rejection reads as `pushed:false`, silently leaving A's stale report as the only thing `check`
    // can ever read back — exactly defeating the point of the cadence once more than one checkout sweeps.
    const { bare, clone: cloneA } = buildFixture('two-clones', { mainCommits: { n: 1 }, branchCommits: { n: 1 } });
    const sweepA = JSON.parse(runSweep(cloneA, ['--branch=feature', '--target=main']));
    expect(sweepA.pushed).toBe(true);

    const cloneB = join(root, 'two-clones-clone-b');
    git(['clone', '-q', bare, cloneB]);
    git(['config', 'user.email', 'test@example.com'], cloneB);
    git(['config', 'user.name', 'Test'], cloneB);
    const sweepB = JSON.parse(runSweep(cloneB, ['--branch=feature', '--target=main']));
    expect(sweepB.noted).toBe(true);
    expect(sweepB.pushed).toBe(true); // must succeed despite B's local notes ref starting EMPTY

    // A THIRD fresh clone reads back B's (the LATEST) report, not A's stale one.
    const cloneC = join(root, 'two-clones-clone-c');
    git(['clone', '-q', bare, cloneC]);
    const checkC = JSON.parse(
      execFileSync('node', [DRIFT_CLI, 'check', '--json', '--branch=feature', '--target=main'], { cwd: cloneC, encoding: 'utf8' }),
    );
    expect(checkC.checkedAt).toBe(sweepB.checkedAt);
  });
});
