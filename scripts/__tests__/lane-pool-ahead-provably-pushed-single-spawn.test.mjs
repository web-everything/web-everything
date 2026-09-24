/**
 * @file scripts/__tests__/lane-pool-ahead-provably-pushed-single-spawn.test.mjs
 * @description Regression test for #2920: `aheadIsProvablyPushed` used to spawn one `git merge-base
 *   --is-ancestor` PER live remote head, per ahead lane — on the real 38-lane pool with 29 remote heads that
 *   was 677 git spawns / ~30s for a single `acquire` auto-pick pass. The fix collapses the per-lane check to
 *   ONE spawn (`git rev-list --ignore-missing --max-count=1 HEAD --not <shas...>`; empty output means every
 *   ahead-commit is contained in some remote head). This file pins two things: (1) the containment semantics
 *   are UNCHANGED (one unpushed commit ⇒ refused; fully pushed ⇒ allowed), reusing the throwaway-origin
 *   pattern from lane-pool-acquire-stale-origin.test.mjs; and (2) the spawn-count ceiling — with MANY remote
 *   heads present, total git process count for one acquire pass must stay small and NOT scale with the
 *   remote-head count (which is exactly the O(ahead-lanes × remote-heads) blowup this item exists to kill).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function runPool(args, extraEnv = {}) {
  // LANE_POOL_ROOT MUST be this test's private tmp dir — without it every command falls back to the real
  // default pool root (~/workspace/.lanes), colliding with the LIVE pool this very task is running under.
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

let base, originDir, referenceDir, poolRoot;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-single-spawn-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=trunk', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  git(['config', 'user.email', 't@t.com'], referenceDir);
  git(['config', 'user.name', 't'], referenceDir);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', originDir, 'HEAD:refs/heads/lane/seed'], referenceDir);
  git(['update-ref', 'refs/heads/trunk', 'refs/heads/lane/seed'], originDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const poolArgs = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=singlespawn', '--branch=trunk', '--no-install'];

describe('aheadIsProvablyPushed containment semantics unchanged (#2920)', () => {
  it('a fully-pushed ahead lane is auto-picked (allowed)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'singlespawn', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // Advance HEAD past the local (stale) origin/trunk ref, then push it — HEAD is now fully pushed under a
    // lane/* ref, but the local origin/trunk ref was never refreshed, so this lane reads as "ahead" locally.
    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed'], lane);
    expect(Number(git(['rev-list', '--count', 'origin/trunk..HEAD'], lane))).toBeGreaterThan(0);

    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker']);
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
  });

  it('a lane with one genuinely unpushed commit is refused (never auto-picked)', () => {
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'singlespawn', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // A single local-only commit, pushed nowhere — no remote ref contains this HEAD.
    writeFileSync(join(lane, 'file.txt'), 'v1\nnever pushed\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'unpushed'], lane);

    // #3383 — `--hard-max=1` pins acquire's own growth-on-empty ceiling at this pool's real size (1 lane), so
    // the fix can't mask "genuinely unpushed, must refuse" by just cloning a fresh lane instead.
    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker', '--hard-max=1']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
  });
});

describe('aheadIsProvablyPushed spawn cost does not scale with remote-head count (#2920)', () => {
  it('one acquire pass stays well under the remote-head count in total git spawns', () => {
    const N_HEADS = 20;
    const provision = runPool(['provision', '--count=1', ...poolArgs()]);
    expect(provision.code).toBe(0);
    const lane = join(poolRoot, 'singlespawn', 'lane-1');
    git(['fetch', '--quiet', 'origin'], lane);

    // Advance HEAD past the local (stale) origin/trunk ref, push it under its own lane/* ref (fully pushed,
    // ahead lane — the code path that pays for the remote-head fan-out).
    writeFileSync(join(lane, 'file.txt'), 'v1\nlanded\n');
    git(['add', 'file.txt'], lane);
    git(['config', 'user.email', 't@t.com'], lane);
    git(['config', 'user.name', 't'], lane);
    git(['commit', '--quiet', '-m', 'landed'], lane);
    git(['push', '--quiet', 'origin', 'HEAD:refs/heads/lane/landed'], lane);

    // Inflate the remote to N_HEADS unrelated branches, from a separate throwaway clone, so `ls-remote` (and,
    // under the OLD code, the per-head merge-base fan-out) has plenty of heads to churn through.
    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    git(['config', 'user.email', 't@t.com'], filler);
    git(['config', 'user.name', 't'], filler);
    for (let i = 0; i < N_HEADS; i++) {
      writeFileSync(join(filler, 'file.txt'), `filler-${i}\n`);
      git(['add', 'file.txt'], filler);
      git(['commit', '--quiet', '-m', `filler ${i}`], filler);
      git(['push', '--quiet', 'origin', `HEAD:refs/heads/lane/filler-${i}`], filler);
    }
    expect(git(['ls-remote', '--heads', 'origin'], lane).split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(N_HEADS);

    // Count every `git` process spawned during the acquire call via a PATH-shimmed counting wrapper.
    const shimDir = join(base, 'bin');
    mkdirSync(shimDir, { recursive: true });
    const spawnLog = join(base, 'git-spawns.log');
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(
      join(shimDir, 'git'),
      `#!/bin/bash\necho "$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`,
    );
    chmodSync(join(shimDir, 'git'), 0o755);

    const acquire = runPool(['acquire', ...poolArgs(), '--no-install', '--session=picker'], {
      PATH: `${shimDir}:${process.env.PATH}`,
    });
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);

    const spawnCount = execFileSync('wc', ['-l', spawnLog], { encoding: 'utf8' }).trim().split(/\s+/)[0];
    // OLD behavior: ≥ N_HEADS merge-base spawns for this one ahead lane alone (one per remote head), on top
    // of everything else acquire does. NEW behavior: one rev-list spawn regardless of remote-head count.
    // The ceiling is generous (covers fetch/ls-remote/status/rev-list/etc. for a 1-lane pool) but is well
    // below N_HEADS, so this fails loudly if the fan-out regresses.
    expect(Number(spawnCount), `git spawns: ${spawnCount} (log: ${spawnLog})`).toBeLessThan(N_HEADS);
  });
});
