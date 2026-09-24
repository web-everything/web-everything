/**
 * @file scripts/__tests__/lane-pool-squash-merge-and-litter-acquirable.test.mjs
 * @description Regression coverage for #3383, live-observed on the plateau-app lane pool: `list --acquirable`
 *   read ZERO acquirable lanes even with several genuinely-idle lanes sitting clean, for two independent
 *   reasons this file pins the fix for:
 *
 *   1. `aheadIsProvablyPushed`'s pre-existing ANCESTRY check (`git rev-list --not <remoteShas>`) never
 *      recognizes a squash/rebase-merged commit — origin gets a NEW commit carrying the same patch, never
 *      built on top of the lane's own commit, so no ancestry walk finds it, even though `git cherry
 *      origin/<branch> HEAD` shows `-` (already applied) for it. The fix adds a patch-equivalence fallback.
 *   2. Several lanes were misread as dirty solely because of untracked agent-scratch litter
 *      (`.pr-body-*.md`, `.open-pr*.json`, `.pr-land-result.json`, `.converge-*`) that delivery/converge
 *      briefs write into the lane root. The fix extends the shared `lib/lane-litter.mjs` allowlist and
 *      applies it (never counting allowlisted-litter-only dirt as real dirt) at every acquire-time decision
 *      point, while a lane with litter PLUS real dirt (tracked or non-allowlisted untracked) stays fully
 *      protected — mirroring the plateau-app pool's own lane-3/lane-8 (real uncommitted source edits).
 *
 *   `list --acquirable` and `acquire`'s auto-pick must AGREE (share the identical decision core) — a lane
 *   the read-only picker reports acquirable must be exactly the one an `acquire` actually takes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function gitc(args, cwd) {
  return git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', ...args], cwd);
}

let base, originDir, referenceDir, poolRoot;

function runPool(args, extraEnv = {}) {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, LANE_POOL_ROOT: poolRoot, ...extraEnv } });
  return { code: r.status ?? 1, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const REPO = () => [`--origin=${originDir}`, `--reference=${referenceDir}`, '--name=squashtest', '--branch=main', '--no-install'];

function listAcquirable() {
  const r = runPool(['list', '--json', '--acquirable', ...REPO()]);
  expect(r.code).toBe(0);
  return JSON.parse(r.out).map((p) => Number(basename(p).slice(5))).sort((a, b) => a - b);
}

function provision(count) {
  const r = runPool(['provision', `--count=${count}`, ...REPO()]);
  expect(r.code).toBe(0);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-squash-litter-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  gitc(['commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('squash/rebase-merged ahead lane is provably pushed (#3383)', () => {
  it('acquire auto-pick takes a lane whose commit is patch-equivalent (not an ancestor) to the live remote tip', () => {
    provision(1);
    const lane = join(poolRoot, 'squashtest', 'lane-1');

    // The lane does its own real work: a brand-new file (a whole-file add keeps the diff hunk free of any
    // surrounding context lines, so patch-id equivalence is unambiguous regardless of unrelated history
    // around it).
    writeFileSync(join(lane, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], lane);
    gitc(['commit', '--quiet', '-m', 'add feature'], lane);
    expect(Number(git(['rev-list', '--count', 'origin/main..HEAD'], lane))).toBe(1);

    // Meanwhile, from an independent clone, OTHER work lands on main first, then a squash/rebase-merge lands
    // the SAME feature content as a brand-new commit built on top of that other work — never on top of the
    // lane's own commit. Ancestry can never see this; only patch-equivalence can.
    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    writeFileSync(join(filler, 'other.txt'), 'unrelated\n');
    git(['add', 'other.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'unrelated work landed first'], filler);
    writeFileSync(join(filler, 'feature.txt'), 'hello\n'); // byte-identical to the lane's own add
    git(['add', 'feature.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'squash-merge add feature (#123)'], filler);
    git(['push', '--quiet', 'origin', 'main'], filler);

    // Confirm the setup actually reproduces the bug's own diagnostic signature: NOT an ancestor, but cherry
    // shows `-` (patch-equivalent) once the lane can see the new tip.
    git(['fetch', '--quiet', 'origin'], lane);
    expect(() => git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main'], lane)).toThrow();
    expect(git(['cherry', 'origin/main', 'HEAD'], lane)).toMatch(/^-/);

    expect(listAcquirable()).toEqual([1]);
    const acquire = runPool(['acquire', ...REPO(), '--session=picker']);
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane);
  });

  it('a lane with a genuinely different (unpushed) patch is NEVER treated as pushed, even after the same fetch', () => {
    provision(1);
    const lane = join(poolRoot, 'squashtest', 'lane-1');

    writeFileSync(join(lane, 'feature.txt'), 'hello\n');
    git(['add', 'feature.txt'], lane);
    gitc(['commit', '--quiet', '-m', 'add feature'], lane);

    // Main moves on with unrelated work, but NOTHING patch-equivalent to the lane's commit ever lands.
    const filler = join(base, 'filler');
    git(['clone', '--quiet', originDir, filler]);
    writeFileSync(join(filler, 'other.txt'), 'unrelated\n');
    git(['add', 'other.txt'], filler);
    gitc(['commit', '--quiet', '-m', 'unrelated work'], filler);
    git(['push', '--quiet', 'origin', 'main'], filler);
    git(['fetch', '--quiet', 'origin'], lane);

    expect(git(['cherry', 'origin/main', 'HEAD'], lane)).toMatch(/^\+/);
    expect(listAcquirable()).toEqual([]);
    // #3383 — `--hard-max=1` pins acquire's own growth-on-empty ceiling at this pool's real size (1 lane), so
    // this test still proves the genuinely-unpushed patch stays refused, rather than self-healing via growth.
    const acquire = runPool(['acquire', ...REPO(), '--session=picker', '--hard-max=1']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
  });
});

describe('litter-only dirty lane is acquirable (#3383)', () => {
  it('a lane whose ONLY untracked content is allowlisted scratch litter is acquirable, and acquire recycles it cleanly', () => {
    provision(2);
    const lane2 = join(poolRoot, 'squashtest', 'lane-2');
    // The exact plateau-app-observed litter shapes: a per-item pr-body, an open-pr result, a pr-land result,
    // and a handful of converge-loop bookkeeping files across several extensions.
    writeFileSync(join(lane2, '.pr-body-2759.md'), 'body\n');
    writeFileSync(join(lane2, '.open-pr-out.json'), '{}\n');
    writeFileSync(join(lane2, '.pr-land-result.json'), '{}\n');
    writeFileSync(join(lane2, '.converge-state.json'), '{}\n');
    writeFileSync(join(lane2, '.converge-panel-r1-result.stderr'), '');

    expect(listAcquirable().sort()).toEqual([1, 2]);

    // Auto-pick prefers the lowest index (lane-1, untouched) first; acquire it explicitly by number instead
    // to prove lane-2 itself is genuinely acquirable and survives its own reset.
    const acquire = runPool(['acquire', '--lane=2', ...REPO(), '--session=picker']);
    expect(acquire.code).toBe(0);
    expect(acquire.out.trim()).toBe(lane2);
    expect(git(['status', '--porcelain'], lane2)).toBe('');
  });

  it('litter PLUS a real uncommitted change stays fully protected (never recycled, never touched)', () => {
    provision(1);
    const lane = join(poolRoot, 'squashtest', 'lane-1');
    writeFileSync(join(lane, '.pr-body-9.md'), 'body\n'); // litter
    writeFileSync(join(lane, 'file.txt'), 'v1\nREAL UNCOMMITTED WORK\n'); // real dirt, same tracked file

    expect(listAcquirable()).toEqual([]);
    // #3383 — pin the growth ceiling at this pool's real size (see the sibling case above for why).
    const acquire = runPool(['acquire', ...REPO(), '--session=picker', '--hard-max=1']);
    expect(acquire.code).not.toBe(0);
    expect(acquire.err).toMatch(/no free lane/);
    // Nothing was touched.
    expect(git(['status', '--porcelain'], lane)).toMatch(/file\.txt/);
    expect(git(['status', '--porcelain'], lane)).toMatch(/\.pr-body-9\.md/);
  });

  it('litter PLUS an untracked file OUTSIDE the allowlist stays fully protected', () => {
    provision(1);
    const lane = join(poolRoot, 'squashtest', 'lane-1');
    writeFileSync(join(lane, '.pr-body-9.md'), 'body\n'); // litter
    execFileSync('mkdir', ['-p', join(lane, 'src')]);
    writeFileSync(join(lane, 'src', 'wip.ts'), 'export const x = 1;\n'); // not litter — real untracked work

    expect(listAcquirable()).toEqual([]);
  });
});
