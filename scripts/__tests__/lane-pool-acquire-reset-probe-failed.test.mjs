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
// `failing` picks which probe fails: 'status' (the tree probe) or 'rev-list' (the ahead-count probe) — the two
// halves of `probeFailed` in laneDirtyOrAhead.
function shimStatusFailsAfterFetch(failing = 'status', failOnce = false) {
  const shimDir = join(base, 'bin');
  mkdirSync(shimDir, { recursive: true });
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const fetched = join(shimDir, 'fetched');
  const failed = join(shimDir, 'status-failed');
  const resetAttempted = join(shimDir, 'reset-attempted');
  writeFileSync(
    join(shimDir, 'git'),
    `#!/bin/bash\n` +
      `args=("$@"); while [ "\${args[0]}" = "-c" ]; do args=("\${args[@]:2}"); done\n` +
      `case "\${args[0]}" in\n` +
      `  fetch) touch "${fetched}" ;;\n` +
      `  checkout|reset|clean) if [ -e "${failed}" ]; then touch "${resetAttempted}"; fi ;;\n` +
      (failing === 'rev-list'
        ? `  rev-list) if [ -e "${fetched}" ] && [[ " \${args[*]} " == *" --count "* ]] && [[ "$PWD" == *"/lane-1" ]]; then if ${failOnce ? '[ ! -e "' + failed + '" ]' : 'true'}; then touch "${failed}"; echo "simulated ${failing} probe error" >&2; exit 1; fi; fi ;;\n`
        : `  status) if [ -e "${fetched}" ] && [[ " \${args[*]} " == *" --porcelain "* ]] && [[ "$PWD" == *"/lane-1" ]]; then if ${failOnce ? '[ ! -e "' + failed + '" ]' : 'true'}; then touch "${failed}"; echo "simulated ${failing} probe error" >&2; exit 1; fi; fi ;;\n`) +
      `esac\n` +
      `exec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shimDir, 'git'), 0o755);
  return { shimDir, failed, resetAttempted };
}

describe('acquire reset-time re-verify fails closed when the status probe fails (scripts/lane-pool.mjs resetBlockedByProbe)', () => {
  it('status probe failure is named and REFUSES the reset after the fetch', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const lane = join(poolRoot, 'resetprobe', 'lane-1');
    const { shimDir, failed, resetAttempted } = shimStatusFailsAfterFetch();

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1'], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(existsSync(failed)).toBe(true); // the shim really failed a post-fetch status probe (the re-verify)
    expect(acquire.code).not.toBe(0);
    expect(existsSync(resetAttempted)).toBe(false);
    expect(acquire.err).toMatch(/no longer provably safe to reset/);
    expect(acquire.err).toContain('probe failed: git status --porcelain: simulated status probe error');
    expect(acquire.err).toMatch(/0 uncommitted/); // the failed probe reported nothing — and was still refused
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('v1\n');
  });

  it('ahead-count probe failure is named and REFUSES the reset after the fetch', () => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const lane = join(poolRoot, 'resetprobe', 'lane-1');
    const { shimDir, failed, resetAttempted } = shimStatusFailsAfterFetch('rev-list');

    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1'], { PATH: `${shimDir}:${process.env.PATH}` });

    expect(existsSync(failed)).toBe(true);
    expect(acquire.code).not.toBe(0);
    expect(existsSync(resetAttempted)).toBe(false);
    expect(acquire.err).toMatch(/no longer provably safe to reset/);
    expect(acquire.err).toContain('probe failed: git rev-list --count origin/trunk..HEAD: simulated rev-list probe error');
    expect(acquire.err).toMatch(/0 uncommitted, 0 ahead/); // a failed count reads as 0 ahead — still refused
    expect(readFileSync(join(lane, 'file.txt'), 'utf8')).toBe('v1\n');
  });

  it.each(['status', 'rev-list'])('retries a transient %s probe failure once and acquire succeeds', (probe) => {
    expect(runPool(['provision', '--count=1', ...poolArgs()]).code).toBe(0);
    const { shimDir, failed } = shimStatusFailsAfterFetch(probe, true);
    const acquire = runPool(['acquire', ...poolArgs(), '--session=picker', '--lane=1'], { PATH: `${shimDir}:${process.env.PATH}` });
    expect(existsSync(failed)).toBe(true);
    expect(acquire.code, acquire.err).toBe(0);
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
    expect(acquire.err).not.toMatch(/no longer provably safe to reset/);
  });
});
