/** Real CLI regressions for ignored build outputs left behind in recycled lanes. */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ignoredBuildOutputDirs, cleanIgnoredBuildOutput } from '../lane-pool.mjs';

const SCRIPT = resolve(process.cwd(), 'scripts/lane-pool.mjs');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 }).trim();
const put = (dir, path, text = 'keep\n') => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

let fixtureRoot, originDir, referenceDir, sharedFixture, base, poolRoot;
beforeAll(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'lane-build-output-fixture-'));
  originDir = join(fixtureRoot, 'origin.git');
  referenceDir = join(fixtureRoot, 'reference');
  git(['init', '--quiet', '--bare', '--initial-branch=main', originDir]);
  git(['clone', '--quiet', originDir, referenceDir]);
  put(referenceDir, '.gitignore', '_site/\n_site-visual-fixtures/\nnode_modules/\n');
  put(referenceDir, '.eleventy.js', 'module.exports = { dir: { output: "_site" } };\n');
  put(referenceDir, 'playwright.config.ts', 'export default { webServer: { command: `eleventy --output=_site-visual-fixtures` } };\n');
  put(referenceDir, '_site/tracked.txt');
  git(['add', '.gitignore', '.eleventy.js', 'playwright.config.ts'], referenceDir);
  git(['add', '-f', '_site/tracked.txt'], referenceDir);
  git(['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'build output fixture'], referenceDir);
  git(['push', '--quiet', 'origin', 'main'], referenceDir);
  sharedFixture = sharedRepos(fixtureRoot, [originDir, referenceDir]);
});
afterAll(() => sharedFixture?.dispose());
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'lane-build-output-'));
  poolRoot = join(base, 'pool');
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
  sharedFixture.restore();
});

function runPool(command, ...args) {
  return spawnSync('node', [SCRIPT, command, `--origin=${originDir}`, `--reference=${referenceDir}`,
    '--name=buildoutputtest', '--branch=main', '--no-install', ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: withGhStub({ ...process.env, LANE_POOL_ROOT: poolRoot }),
  });
}
function provision() {
  const result = runPool('provision', '--count=1');
  expect(result.status, result.stderr).toBe(0);
  return join(poolRoot, 'buildoutputtest', 'lane-1');
}

describe('ignored build output cleanup', () => {
  for (const command of ['acquire', 'refresh']) {
    it(`removes stale ignored test files on ${command}, only in that lane`, () => {
      const lane = provision();
      const stale = ['_site/assets/js/__tests__/x.test.ts', '_site-visual-fixtures/y.test.ts'];
      for (const file of stale) {
        put(lane, file);
        put(referenceDir, file);
      }
      put(lane, 'node_modules/keep.js');
      const result = runPool(command, '--lane=1');
      expect(result.status, result.stderr).toBe(0);
      for (const file of stale) {
        expect(existsSync(join(lane, file))).toBe(false);
        expect(existsSync(join(referenceDir, file))).toBe(true);
      }
      expect(readFileSync(join(lane, '_site/tracked.txt'), 'utf8')).toBe('keep\n');
      expect(readFileSync(join(lane, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
    });
  }

  it('preserves non-ignored untracked files inside a configured output and at top level', () => {
    // Ignore individual generated files, leaving source files in the same output tree non-ignored.
    put(referenceDir, '.gitignore', '_site/**/*.test.ts\n_site-visual-fixtures/\nnode_modules/\n');
    put(referenceDir, '_site/assets/source.ts');
    put(referenceDir, 'top-level.txt');
    put(referenceDir, '_site/assets/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site/assets/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, '_site/assets/source.ts'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(referenceDir, 'top-level.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves tracked files inside ignored output directories', () => {
    put(referenceDir, '_site/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, '_site/tracked.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves ignored node_modules outside configured outputs', () => {
    put(referenceDir, 'node_modules/keep.js');
    put(referenceDir, '_site-visual-fixtures/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site-visual-fixtures/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
  });

  it('derives custom names from dir.output and every Playwright output, deduplicating them', () => {
    put(base, '.eleventy.js', 'module.exports = { output: "unrelated", dir: { output: "custom-site" } };');
    put(base, 'playwright.config.ts', 'const commands = [`build --output=visual-one`, "build --output=visual-two --quiet", `build --output=visual-one`];');
    expect(ignoredBuildOutputDirs(base)).toEqual(['custom-site', 'visual-one', 'visual-two']);
  });

  it.each(['', '.', '..', '../outside', 'nested/output', '/absolute', '.hidden', 'a..b', 'a\\b', '*', ':(glob)*', '${output}'])('rejects unsafe output name %j', (name) => {
    put(base, '.eleventy.js', `module.exports = { dir: { output: "${name}" } };`);
    put(base, 'playwright.config.ts', `const command = \`build --output=${name}\`;`);
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
  });

  it('falls back to no outputs for unreadable or unrecognised configs', () => {
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    mkdirSync(join(base, '.eleventy.js'));
    mkdirSync(join(base, 'playwright.config.ts'));
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    rmSync(join(base, '.eleventy.js'), { recursive: true });
    rmSync(join(base, 'playwright.config.ts'), { recursive: true });
    put(base, '.eleventy.js', 'module.exports = { output: "not-dir-output" };');
    put(base, 'playwright.config.ts', 'export default {};');
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
  });

  it('does nothing when configured outputs do not exist', () => {
    put(base, '.eleventy.js', 'module.exports = { dir: { output: "missing-output" } };');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => cleanIgnoredBuildOutput(base)).not.toThrow();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('does not follow an output symlink outside the lane', () => {
    put(base, 'outside/keep.test.ts');
    symlinkSync(join(base, 'outside'), join(referenceDir, '_site-visual-fixtures'));
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(base, 'outside/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site-visual-fixtures'))).toBe(true);
  });

  it('logs cleanup failure and returns without throwing', () => {
    // An existing output in a non-repository forces the real git command to fail.
    put(base, '.eleventy.js', 'module.exports = { dir: { output: "output" } };');
    put(base, 'output/keep.txt');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(() => cleanIgnoredBuildOutput(base)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/ignored build output cleanup failed/));
    expect(existsSync(join(base, 'output/keep.txt'))).toBe(true);
  });
});
