/**
 * @file scripts/__tests__/lane-pool-acquire-reset-probe-failed.test.mjs
 * @description Covers the reset-time re-verify in `provisionClaimedLane` (scripts/lane-pool.mjs, the
 *   `resetBlockedByProbe` call). A `git status` that FAILS after the fetch (spawn error, kill, EMFILE under
 *   load) reads as "0 uncommitted"; the re-verify must treat that unknown tree as dirty and refuse the
 *   destructive `checkout --force` / `clean`, so an uncommitted edit is never wiped on a flaky probe.
 *
 *   A `git` PATH shim makes `git status --porcelain` fail only AFTER the `git fetch` of the acquire has run,
 *   i.e. exactly at the reset-time re-verify (pick-time scan + pre-claim checks have already seen a clean lane).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { sharedRepos } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let base, originDir, referenceDir, poolRoot, fixtureRoot, sharedFixture;

const runPool = (args, extraEnv = {}) => {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
};

beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-pool-resetprobe-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'HEAD:refs/heads/trunk'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'lane-pool-resetprobe-')); poolRoot = join(base, 'pool'); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); sharedFixture.restore(); });

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=resetprobe', '--branch=trunk', '--no-install'];

// `git fetch` drops a marker; once it exists, `git status --porcelain` run inside a lane exits 1 (a failed probe).
function shimStatusFailsAfterFetch() {
  const shimDir = join(base, 'bin');
  mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fetched = join(shimDir, 'fetched');
  const failed = join(shimDir, 'status-failed');
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/bash\n` +
      `args=("$@"); while [ "\${args[0]}" = "-c" ]; do args=("\${args[@]:2}"); done\n` +
      `case "\${args[0]}" in\n` +
      `  fetch) touch "${fetched}" ;;\n` +
      `  status) if [ -e "${fetched}" ] && [[ " \${args[*]} " == *" --porcelain "* ]] && [[ "$PWD" == *"/lane-1" ]]; then touch "${failed}"; exit 1; fi ;;\n` +
      `esac\n` +
      `exec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
  return { shimDir, failed };
}

describe('acquire reset-time re-verify fails closed when the status probe fails (scripts/lane-pool.mjs resetBlockedByProbe)', () => {
  it('REFUSES the reset and keeps a lane edit when `git status` fails after the fetch', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const lane = join(poolRoot, 'resetprobe', 'lane-1');
    const { shimDir, failed } = shimStatusFailsAfterFetch();

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1'], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(existsSync(failed)).toBe(true); // the shim really failed a post-fetch status probe (the re-verify)
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no longer provably safe to reset/);
    expect(acquire.err).toMatch(/0 uncommitted/); // the failed probe reported nothing — and was still refused
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('v1\n');
  });

  it('control: the same acquire without the shim succeeds, so the refusal above is the failed probe', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1']);
    expect(acquire.code).toBe(0);
  });

  it('--force still proceeds past a failed probe (documented override)', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const { shimDir } = shimStatusFailsAfterFetch();
    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1', '--force'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(acquire.code).toBe(0);
  });
});
