/** Real CLI regressions for ignored build outputs left behind in recycled lanes. */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { resolve, join, dirname, delimiter } from 'node:path';
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
  git(['add', '.gitignore', '.eleventy.js', 'playwright.config.ts'], referenceDir);
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
  vi.unstubAllEnvs();
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
      expect(readFileSync(join(lane, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
    });
  }

  it('refuses outputs whose directory is not ignored, even when individual files are ignored', () => {
    // Ignore individual generated files, leaving source files in the same output tree non-ignored.
    put(referenceDir, '.gitignore', '_site/**/*.test.ts\n_site-visual-fixtures/\nnode_modules/\n');
    put(referenceDir, '_site/assets/source.ts');
    put(referenceDir, 'top-level.txt');
    put(referenceDir, '_site/assets/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site/assets/stale.test.ts'))).toBe(true);
    expect(readFileSync(join(referenceDir, '_site/assets/source.ts'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(referenceDir, 'top-level.txt'), 'utf8')).toBe('keep\n');
  });

  it.each(['.eleventy.js', 'playwright.config.ts'])('refuses an ignored output containing tracked files from %s', (config) => {
    put(referenceDir, config, config === '.eleventy.js'
      ? 'module.exports = { dir: { output: "tracked-output" } };'
      : 'const command = `build --output=tracked-output`;');
    put(referenceDir, '.gitignore', 'tracked-output/\n');
    put(referenceDir, 'tracked-output/tracked.txt');
    git(['add', '-f', 'tracked-output/tracked.txt'], referenceDir);
    put(referenceDir, 'tracked-output/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('tracked-output');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, 'tracked-output/stale.test.ts'))).toBe(true);
    expect(readFileSync(join(referenceDir, 'tracked-output/tracked.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves ignored node_modules when a Playwright comment names it as output', () => {
    put(referenceDir, 'playwright.config.ts', '// build --output=node_modules\nexport default {};\n');
    put(referenceDir, 'node_modules/keep.js');
    put(referenceDir, '_site/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
  });

  it('preserves ignored node_modules outside configured outputs', () => {
    put(referenceDir, 'node_modules/keep.js');
    put(referenceDir, '_site-visual-fixtures/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site-visual-fixtures/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
  });

  it('derives custom names from dir.output and every Playwright output, deduplicating them', () => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', 'custom-site/\nvisual-one/\nvisual-two/\n');
    put(base, '.eleventy.js', 'module.exports = { output: "unrelated", dir: { output: "custom-site" } };');
    put(base, 'playwright.config.ts', 'const commands = [`build --output=visual-one`, "build --output=visual-two --quiet", `build --output=visual-one`];');
    expect(ignoredBuildOutputDirs(base)).toEqual(['custom-site', 'visual-one', 'visual-two']);
  });

  it.each(['node_modules', '.git', '.claude', 'src', 'scripts', 'docs'])('refuses denylisted output %s from either config', (name) => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', `${name}/\n`);
    put(base, '.eleventy.js', `module.exports = { dir: { output: "${name}" } };`);
    put(base, 'playwright.config.ts', `// build --output=${name}\n`);
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
  });

  it('refuses configured outputs when Git eligibility evidence is unavailable', () => {
    put(base, '.eleventy.js', 'module.exports = { dir: { output: "output" } };');
    put(base, '.gitignore', 'output/\n');
    put(base, 'output/keep.txt');
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    cleanIgnoredBuildOutput(base);
    expect(existsSync(join(base, 'output/keep.txt'))).toBe(true);
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
    git(['init', '--quiet'], base);
    put(base, '.gitignore', 'missing-output/\n');
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

  for (const command of ['acquire', 'refresh']) {
    it(`surfaces cleanup failure on ${command} without a corruption retry`, () => {
      const lane = provision();
      put(lane, '_site/stale.test.ts');
      const bin = join(base, 'bin');
      const attempts = join(base, 'cleanup-attempts');
      // Fail only ignored-output cleanup; every other Git operation uses the real binary.
      put(bin, 'git', `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('clean') && args.includes('-fdX')) {
  appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
  process.stderr.write('fatal: bad object cleanup probe\\n');
  process.exit(1);
}
try {
  execFileSync('git', args, { stdio: 'inherit', timeout: 20000,
    env: { ...process.env, PATH: ${JSON.stringify(process.env.PATH)} } });
} catch (error) { process.exit(error.status || 1); }
`);
      chmodSync(join(bin, 'git'), 0o755);
      vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH}`);
      const result = runPool(command, '--lane=1');
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('ignored build output cleanup failed');
      expect(readFileSync(attempts, 'utf8')).toBe('attempt\n');
      expect(existsSync(join(lane, '_site/stale.test.ts'))).toBe(true);
      expect(existsSync(join(poolRoot, 'buildoutputtest', '.quarantine'))).toBe(false);
    });
  }
});
