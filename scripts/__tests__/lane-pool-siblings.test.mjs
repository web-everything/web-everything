/**
 * @file scripts/__tests__/lane-pool-siblings.test.mjs
 * @description Proof of the #2349 generalization of `ensureFuiSibling` (#2166) into a per-repo
 *   pushable+built sibling-clone provisioner, ratified in #2282
 *   (docs/agent/platform-decisions.md#pool-siblings-real-built-clones). These tests spawn the real CLI
 *   against throwaway local origins + reference checkouts (no network, no shared pool root) and assert:
 *   the WE pool provisions REAL git clones (not symlinks) for its constellation siblings; each sibling is
 *   rebuilt via its own `build:tools` where it has one; a legacy pre-#2282 symlink is replaced with a real
 *   clone; a dirty/ahead sibling clone is left untouched on refresh (the #2267 data-loss guard, now
 *   load-bearing for a real pushable clone too); and a non-WE pool provisions no siblings at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
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

// A tiny dependency-free package published at a `file:` path under `base`, so `npm ci`/`npm install`
// resolves it fully OFFLINE (no registry). A `requiresDeps` build:tools `require`s it, so the build can
// ONLY succeed if the provisioner installed the clone's node_modules first — the regression this guards.
function makeLocalDep() {
  const dir = join(base, 'localdep');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'localdep', version: '1.0.0', main: 'index.js' }) + '\n');
  writeFileSync(join(dir, 'index.js'), 'module.exports = 42;\n');
  return dir;
}

// Creates a bare origin + a checkout SIBLING of `referenceDir` (i.e. under `base`, matching
// `primarySiblingPath`'s `dirname(repo.referencePath)` resolution), with an optional `build:tools` script.
// `requiresDeps` (only meaningful with `withBuildTools`) makes the build depend on an installed module, so
// it fails on a fresh clone unless the provisioner ran `npm ci`/`install` on the clone first (#2349).
function makeSiblingPrimary(name, { withBuildTools, requiresDeps } = {}) {
  const originBare = join(base, `${name}-origin.git`);
  const checkout = join(base, name); // sibling of referenceDir (both live directly under base)
  git(['init', '--quiet', '--bare', '--initial-branch=main', originBare]);
  git(['clone', '--quiet', originBare, checkout]);
  const pkg = { name, version: '0.0.0', scripts: {} };
  if (withBuildTools && requiresDeps) {
    // `require('localdep')` resolves ONLY if node_modules was installed on the fresh clone — a build with
    // no deps throws ERR_MODULE_NOT_FOUND (mirrors FUI's static `import esbuild` / `npx tsc`), so the
    // dist/ marker never appears and the build-produces-dist assertion fails if npm ci was skipped.
    pkg.dependencies = { localdep: `file:${makeLocalDep()}` };
    pkg.scripts['build:tools'] =
      'node -e "require(\'localdep\');require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/marker.txt\',\'built\\n\')"';
  } else if (withBuildTools) {
    // Pure-node script — no deps needed, so `npm run build:tools` works with no node_modules.
    pkg.scripts['build:tools'] =
      'node -e "require(\'fs\').mkdirSync(\'dist\',{recursive:true});require(\'fs\').writeFileSync(\'dist/marker.txt\',\'built\\n\')"';
  } else {
    pkg.scripts.build = 'echo not-a-build-tools-repo';
  }
  writeFileSync(join(checkout, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync(join(checkout, 'file.txt'), 'v1\n');
  git(['add', '.'], checkout);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], checkout);
  git(['push', '--quiet', 'origin', 'main'], checkout);
  return { originBare, checkout };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-pool-siblings-'));
  originDir = join(base, 'origin.git');
  referenceDir = join(base, 'reference');
  poolRoot = join(base, 'pool');

  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  writeFileSync(join(referenceDir, 'file.txt'), 'v1\n');
  git(['add', 'file.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'v1'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function provisionWePool() {
  makeSiblingPrimary('frontierui', { withBuildTools: true });
  makeSiblingPrimary('plateau-app', { withBuildTools: false });
  return runPool(
    ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install'],
    { LANE_POOL_ROOT: poolRoot },
  );
}

describe('lane-pool constellation sibling clones (#2166 → #2282 → #2349)', () => {
  it('provisions REAL pushable clones (not symlinks) for frontierui + plateau-app on the WE pool', () => {
    const r = provisionWePool();
    expect(r.code).toBe(0);
    const fuiDir = join(poolRoot, 'web-everything', 'frontierui');
    const plateauDir = join(poolRoot, 'web-everything', 'plateau-app');
    expect(existsSync(join(fuiDir, '.git'))).toBe(true);
    expect(lstatSync(fuiDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(plateauDir, '.git'))).toBe(true);
    expect(lstatSync(plateauDir).isSymbolicLink()).toBe(false);
    // A real pushable clone: its own origin remote points at the primary sibling's bare origin, not a
    // symlink pointing at the primary checkout itself.
    expect(git(['remote', 'get-url', 'origin'], fuiDir)).toBe(join(base, 'frontierui-origin.git'));
  });

  it('installs the clone deps then rebuilds a sibling via its own build:tools (skips where it has none)', () => {
    // frontierui's build:tools `require`s a dep that exists ONLY after the provisioner installs the fresh
    // clone's node_modules — so this asserts the #2349 `ensureDeps`-before-build:tools step really runs
    // (`--reference` shares git objects, NOT node_modules), not just that some build:tools was invoked.
    makeSiblingPrimary('frontierui', { withBuildTools: true, requiresDeps: true });
    makeSiblingPrimary('plateau-app', { withBuildTools: false });
    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const fuiDir = join(poolRoot, 'web-everything', 'frontierui');
    // Deps were installed on the clone (the direct proof the provisioner didn't skip npm ci/install).
    expect(existsSync(join(fuiDir, 'node_modules', 'localdep'))).toBe(true);
    // And the build — which imports that dep — produced its dist/ artifact (fails if deps were skipped).
    const fuiMarker = join(fuiDir, 'dist', 'marker.txt');
    expect(existsSync(fuiMarker)).toBe(true);
    expect(readFileSync(fuiMarker, 'utf8')).toBe('built\n');
    // plateau-app has no build:tools script — no dist/ (and no deps install) from this provisioner.
    expect(existsSync(join(poolRoot, 'web-everything', 'plateau-app', 'dist'))).toBe(false);
  });

  it('replaces a legacy pre-#2282 symlink sibling with a real clone', () => {
    makeSiblingPrimary('frontierui', { withBuildTools: true });
    makeSiblingPrimary('plateau-app', { withBuildTools: false });
    // Pre-seed the pool dir with the OLD #2166 symlink before provisioning.
    const poolDir = join(poolRoot, 'web-everything');
    execFileSync('mkdir', ['-p', poolDir]);
    symlinkSync(join(base, 'frontierui'), join(poolDir, 'frontierui'));
    expect(lstatSync(join(poolDir, 'frontierui')).isSymbolicLink()).toBe(true);

    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    const fuiDir = join(poolDir, 'frontierui');
    expect(lstatSync(fuiDir).isSymbolicLink()).toBe(false);
    expect(existsSync(join(fuiDir, '.git'))).toBe(true);
  });

  it('leaves a DIRTY sibling clone untouched on refresh (data-loss guard, now load-bearing for a real clone)', () => {
    expect(provisionWePool().code).toBe(0);
    const fuiDir = join(poolRoot, 'web-everything', 'frontierui');
    writeFileSync(join(fuiDir, 'file.txt'), 'v1\nUNCOMMITTED EDIT\n');

    const r = runPool(
      ['refresh', `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(fuiDir, 'file.txt'), 'utf8')).toBe('v1\nUNCOMMITTED EDIT\n');
  });

  it('WARNS (not crashes) when a sibling clone fails — the WE lanes still provision + status still prints', () => {
    const fui = makeSiblingPrimary('frontierui', { withBuildTools: true });
    makeSiblingPrimary('plateau-app', { withBuildTools: false });
    // Break the frontierui origin AFTER its primary checkout has it configured, so `git remote get-url
    // origin` still resolves a URL but the actual `git clone <url>` fails (simulates a network blip / moved
    // remote / auth failure — the primary's own checkout is otherwise perfectly healthy).
    rmSync(fui.originBare, { recursive: true, force: true });

    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0); // must not crash the whole command
    expect(r.err).toMatch(/frontierui sibling clone failed/);
    // The WE lane itself must still have been provisioned despite the sibling clone failure.
    expect(existsSync(join(poolRoot, 'web-everything', 'lane-1', '.git'))).toBe(true);
    // No partial/broken clone left behind.
    expect(existsSync(join(poolRoot, 'web-everything', 'frontierui'))).toBe(false);
  });

  it('provisions NO siblings for a non-WE pool (no PORT_BANDS entry)', () => {
    makeSiblingPrimary('frontierui', { withBuildTools: true });
    makeSiblingPrimary('plateau-app', { withBuildTools: false });
    const r = runPool(
      ['provision', '--count=1', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=some-other-pool', '--branch=main', '--no-install'],
      { LANE_POOL_ROOT: poolRoot },
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(poolRoot, 'some-other-pool', 'frontierui'))).toBe(false);
    expect(existsSync(join(poolRoot, 'some-other-pool', 'plateau-app'))).toBe(false);
  });
});

describe('lane-pool heal-siblings (R817: Forge needs ../frontierui next to every lane)', () => {
  const healArgs = (extra = []) => [
    'heal-siblings', `--origin=${originDir}`, `--reference=${referenceDir}`, '--name=web-everything', '--branch=main', '--no-install', ...extra,
  ];
  const heal = (extra) => runPool(healArgs(extra), { LANE_POOL_ROOT: poolRoot });
  const poolFui = () => join(poolRoot, 'web-everything', 'frontierui');
  const danglingPath = () => join(base, 'frontierui', 'frontierui');
  const setup = () => {
    makeSiblingPrimary('frontierui', { withBuildTools: true });
    makeSiblingPrimary('plateau-app', { withBuildTools: false });
    mkdirSync(join(poolRoot, 'web-everything'), { recursive: true });
  };

  it('heal-recreates: an absent pool-root sibling comes back as a REAL clone, not a symlink', () => {
    setup();
    expect(existsSync(poolFui())).toBe(false);
    const r = heal();
    expect(r.code).toBe(0);
    expect(lstatSync(poolFui()).isSymbolicLink()).toBe(false);
    expect(existsSync(join(poolFui(), '.git'))).toBe(true);
  });

  it('dangling-symlink-removed: a dangling symlink at the primary sibling path is removed and logged once', () => {
    setup();
    symlinkSync(join(base, 'no-such-target'), danglingPath());
    const r = heal();
    expect(r.code).toBe(0);
    expect(() => lstatSync(danglingPath())).toThrow();
    expect((r.err + r.out).match(/removed dangling symlink/g) || []).toHaveLength(1);
  });

  it('live-symlink-kept: a symlink whose target exists is never removed', () => {
    setup();
    const target = join(base, 'live-target');
    mkdirSync(target);
    symlinkSync(target, danglingPath());
    expect(heal().code).toBe(0);
    expect(lstatSync(danglingPath()).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it('real-dir-kept: a real directory (and an untracked .claude/) at those paths is never touched', () => {
    setup();
    mkdirSync(danglingPath());
    writeFileSync(join(danglingPath(), 'keep.txt'), 'x\n');
    mkdirSync(join(base, 'frontierui', '.claude'));
    writeFileSync(join(base, 'frontierui', '.claude', 'keep.json'), '{}\n');
    expect(heal().code).toBe(0);
    expect(readFileSync(join(danglingPath(), 'keep.txt'), 'utf8')).toBe('x\n');
    expect(readFileSync(join(base, 'frontierui', '.claude', 'keep.json'), 'utf8')).toBe('{}\n');
  });

  it('dry-run-no-op: --dry-run reports but changes nothing', () => {
    setup();
    symlinkSync(join(base, 'no-such-target'), danglingPath());
    const r = heal(['--dry-run']);
    expect(r.code).toBe(0);
    expect(lstatSync(danglingPath()).isSymbolicLink()).toBe(true);
    expect(existsSync(poolFui())).toBe(false);
    expect(r.err + r.out).toMatch(/dry.?run/i);
  });
});
