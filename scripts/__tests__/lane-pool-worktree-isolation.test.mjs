/**
 * @file scripts/__tests__/lane-pool-worktree-isolation.test.mjs
 * @description #x9fbg1x — every lane clone this pool hands out must carry Claude Code's own background-session
 *   worktree-isolation guard turned OFF, via an UNTRACKED `.claude/settings.local.json` — NEVER the tracked,
 *   repo-wide `.claude/settings.json` (which no longer carries this key at all). Spawns the real CLI against a
 *   throwaway local origin + reference checkout (no network, no shared pool root), the same convention
 *   `lane-pool-acquire-base.test.mjs` already uses.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-worktree-isolation-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'main-tip\n');
  // A tracked `.claude/settings.json` WITHOUT a `worktree` key — matching THIS repo's own post-fix state
  // (`.claude/` already exists and is tracked; the removed key is what this whole card's diff replaces). This
  // also matters mechanically: `writeLaneClaudeSettings` (see `lane-pool.mjs`'s own doc) deliberately SKIPS a
  // checkout whose `.claude/` isn't already tracked — a brand-new, wholly-untracked `.claude/` directory
  // collapses to one `git status --porcelain` line no per-file litter-allowlist entry can match, misreading
  // the whole lane as dirty (reproduced live building this fix). Committing this file up front is what makes
  // this fixture representative of the real repo instead of accidentally exercising that skip path.
  mkdirSync(join(referenceDir, '.claude'), { recursive: true });
  writeFileSync(join(referenceDir, '.claude', 'settings.json'), '{}\n');
  git(['add', 'file.txt', '.claude/settings.json'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-worktree-isolation-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function laneSettingsPath(n) {
  return join(poolRoot, 'witest', `lane-${n}`, '.claude', 'settings.local.json');
}

describe('lane-pool provisions every lane with the worktree-isolation override (#x9fbg1x)', () => {
  it('a freshly PROVISIONED lane carries worktree.bgIsolation:none in its OWN untracked settings.local.json', () => {
    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const path = laneSettingsPath(1);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ worktree: { bgIsolation: 'none' } });
  });

  it('survives a REFRESH (which runs `git clean -fd` against the untracked lane tree)', () => {
    runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(laneSettingsPath(1), 'utf8')).worktree).toEqual({ bgIsolation: 'none' });
  });

  it('is ADDITIVE with whatever else already lives in that lane\'s settings.local.json (e.g. a gh-shim env write)', () => {
    runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    const path = laneSettingsPath(1);
    const before = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...before, env: { PATH: '/some/shim:/usr/bin' } }));
    const r = runPool(
      ['refresh', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.env).toEqual({ PATH: '/some/shim:/usr/bin' });
    expect(after.worktree).toEqual({ bgIsolation: 'none' });
  });

  it('a lane reclaimed by ACQUIRE (reset --hard + clean -fd) still carries it afterward', () => {
    runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    const r = runPool(
      ['acquire', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install', '--json'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(laneSettingsPath(1), 'utf8')).worktree).toEqual({ bgIsolation: 'none' });
  });

  it('the tracked, repo-wide `.claude/settings.json` this lane checked out carries NO `worktree` key — the '
    + 'primary checkout keeps the CLI\'s default guard, this repo-wide entry was removed on purpose (#x9fbg1x)', () => {
    runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=witest', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    const trackedPath = join(poolRoot, 'witest', 'lane-1', '.claude', 'settings.json');
    expect(existsSync(trackedPath)).toBe(true); // committed by this fixture's own beforeEach, matching reality
    expect(JSON.parse(readFileSync(trackedPath, 'utf8'))).not.toHaveProperty('worktree');
  });

  it('SKIPS the write entirely for a checkout with NO tracked `.claude/` at all — never creates a brand-new, '
    + 'wholly-untracked `.claude/` directory that would collapse to one unmatchable dirty porcelain line', () => {
    const bareBase = mkdtempSync(join(tmpdir(), 'lane-pool-worktree-isolation-bare-'));
    const bareOrigin = join(bareBase, 'origin.git');
    const bareReference = join(bareBase, 'reference');
    git(['init', '--quiet', '--bare', '--initial-branch=main', bareOrigin]);
    git(['clone', '--quiet', bareOrigin, bareReference]);
    writeFileSync(join(bareReference, 'file.txt'), 'no .claude here\n');
    git(['add', 'file.txt'], bareReference);
    git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], bareReference);
    git(['push', '--quiet', 'origin', 'main'], bareReference);
    try {
      const barePoolRoot = join(bareBase, 'pool');
      const r = runPool(
        ['provision', '--count=1', `--origin=${bareOrigin}`, `--reference=${bareReference}`, '--name=bare', '--branch=main', '--no-install'],
        { LANE_POOL_ROOT: barePoolRoot },
      );
      expect(r.code).toBe(0);
      expect(existsSync(join(barePoolRoot, 'bare', 'lane-1', '.claude'))).toBe(false);
      // And the lane still reads CLEAN — the whole point of the skip.
      const acquireResult = runPool(
        ['acquire', `--origin=${bareOrigin}`, `--reference=${bareReference}`, '--name=bare', '--branch=main', '--no-install'],
        { LANE_POOL_ROOT: barePoolRoot },
      );
      expect(acquireResult.code).toBe(0);
    } finally {
      rmSync(bareBase, { recursive: true, force: true });
    }
  });
});
