/**
 * @file scripts/__tests__/lane-pool-flag-validation.test.mjs
 * @description Regression for a real incident: `node scripts/lane-pool.mjs acquire --help` (meant to print
 *   usage) was accepted as a plain, no-`--lane` `acquire` with `help` silently added to `flags` and never
 *   checked — auto-picking a free lane and resetting it, no error, no warning. The arg parser puts ANY
 *   `--foo`/`--foo=bar` into `flags` with zero validation, so this is generic to any typo'd or unsupported
 *   flag on any command, not just `--help`. These tests spawn the real CLI (no network, throwaway origin) and
 *   assert: an unrecognized flag now hard-fails loud before touching anything; a stray positional argument
 *   does too; and a representative flag from each command (not just `acquire`) still works, so the fix does
 *   not reject anything real.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
const common = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=flagtest', '--branch=main', '--no-install'];

// One origin + reference per FILE (built once, restored after every test) instead of one per test — see
// fixtures/shared-git-fixture.mjs. Everything else a test creates still lives in its own fresh `base`.
let fixtureRoot, sharedFixture;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-flag-validation-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  execFileSync('sh', ['-c', 'echo main-tip > file.txt'], { cwd: referenceDir });
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'main v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});

afterAll(() => sharedFixture?.dispose());

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-flag-validation-'));
  poolRoot = join(base, 'pool');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

describe('lane-pool unrecognized-flag guard (regression: acquire --help auto-picked and reset a lane)', () => {
  it('rejects the exact incident shape — acquire --help — instead of silently running a plain acquire', () => {
    const r = runPool(['provision', '--count=1', ...common()], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).toBe(0);
    const lane = join(poolRoot, 'flagtest', 'lane-1');

    const before = git(['rev-parse', 'HEAD'], lane);
    const acquireHelp = runPool(['acquire', ...common(), '--help'], { LANE_POOL_ROOT: poolRoot });

    expect(acquireHelp.code).not.toBe(0);
    expect(acquireHelp.err).toMatch(/unrecognized flag/);
    expect(acquireHelp.err).toMatch(/--help/);
    // No lease was taken and the lane's HEAD is untouched — the failure happens before any lane is selected.
    expect(existsSync(join(lane, '.git', '.lane-lease'))).toBe(false);
    expect(git(['rev-parse', 'HEAD'], lane)).toBe(before);
  });

  it('rejects an unrecognized flag on other commands too (generic, not acquire-specific)', () => {
    const r = runPool(['status', ...common(), '--jsonn'], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/unrecognized flag/);
    expect(r.err).toMatch(/--jsonn/);
  });

  it('rejects a stray positional argument after the command', () => {
    const r = runPool(['status', 'garbage', ...common()], { LANE_POOL_ROOT: poolRoot });
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/unexpected extra argument/);
    expect(r.err).toMatch(/garbage/);
  });

  it('still accepts a real flag specific to each command (the fix is not over-strict)', () => {
    expect(runPool(['provision', '--count=1', '--acquirable', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['list', '--acquirable', '--json', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['status', '--json', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['path', '--lane=1', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);

    const acq = runPool(['acquire', '--lane=1', '--purpose=t', '--session=t', '--scope=x:y', '--wait-ms=0', '--json', ...common()], { LANE_POOL_ROOT: poolRoot });
    expect(acq.code).toBe(0);

    // `adopt` hard-fails without a durable session id (CLAUDE_CODE_SESSION_ID) to stamp — stub one so this
    // assertion doesn't depend on whether the process running the test happens to have one set (it does in
    // an interactive Claude Code shell, but not in a bare CI runner shell).
    expect(
      runPool(['adopt', '--lane=1', '--json', ...common()], { LANE_POOL_ROOT: poolRoot, CLAUDE_CODE_SESSION_ID: 'flagtest-session' }).code,
    ).toBe(0);
    // `map`/`unmap` need a pool name with a registered dev-server port band (unrelated to flag validation) —
    // just confirm their OWN `--item`/`--lane` flags aren't rejected as unrecognized.
    expect(runPool(['map', '--lane=1', '--item=1', ...common()], { LANE_POOL_ROOT: poolRoot }).err).not.toMatch(/unrecognized flag/);
    expect(runPool(['unmap', '--lane=1', ...common()], { LANE_POOL_ROOT: poolRoot }).err).not.toMatch(/unrecognized flag/);
    expect(runPool(['release', '--lane=1', '--session=t', '--force', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
    expect(runPool(['remove', '--lane=1', ...common()], { LANE_POOL_ROOT: poolRoot }).code).toBe(0);
  });
});
