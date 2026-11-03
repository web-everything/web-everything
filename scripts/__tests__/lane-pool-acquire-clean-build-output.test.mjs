/** Real CLI regressions for ignored build outputs left behind in recycled lanes. */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sharedRepos, withGhStub } from './fixtures/shared-git-fixture.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { resolve, join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { ignoredBuildOutputDirs, cleanIgnoredBuildOutput } from '../lane-pool.mjs';

const eleventyConfig = (name) => `module.exports = {\n  dir: {\n    output: "${name}",\n  },\n};\n`;
const playwrightCommand = (name) => '  command: `npx @11ty/eleventy --output=' + name + '`,\n';

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
  put(referenceDir, '.eleventy.js', eleventyConfig('_site'));
  put(referenceDir, 'playwright.config.ts', 'export default { webServer: {\n' + playwrightCommand('_site-visual-fixtures') + '} };\n');
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
  it('uses the naming convention regardless of declared, missing, or garbled configs', () => {
    put(referenceDir, '.gitignore', '_site/\nbackups/\n');
    put(referenceDir, '.eleventy.js', eleventyConfig('backups'));
    put(referenceDir, 'playwright.config.ts', 'export default { webServer: {\n' + playwrightCommand('backups') + '} };\n');
    put(referenceDir, 'backups/keep.test.ts');
    const checkCleanup = () => {
      put(referenceDir, '_site/stale.test.ts');
      expect(ignoredBuildOutputDirs(referenceDir)).toEqual(['_site']);
      cleanIgnoredBuildOutput(referenceDir);
      expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
      expect(readFileSync(join(referenceDir, 'backups/keep.test.ts'), 'utf8')).toBe('keep\n');
    };
    checkCleanup();
    rmSync(join(referenceDir, '.eleventy.js'));
    rmSync(join(referenceDir, 'playwright.config.ts'));
    checkCleanup();
    put(referenceDir, '.eleventy.js', 'garbled { config');
    put(referenceDir, 'playwright.config.ts', 'garbled ` config');
    checkCleanup();
  });

  it('preserves an ignored backups directory', () => {
    put(referenceDir, '.gitignore', 'backups/\n');
    put(referenceDir, 'backups/keep.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('backups');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'backups/keep.test.ts'), 'utf8')).toBe('keep\n');
  });

  it('preserves an unignored _site-foo directory', () => {
    put(referenceDir, '_site-foo/keep.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('_site-foo');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, '_site-foo/keep.test.ts'), 'utf8')).toBe('keep\n');
  });

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

  it('preserves an ignored _site-foo directory containing a tracked file', () => {
    put(referenceDir, '.gitignore', '_site-foo/\n');
    put(referenceDir, '_site-foo/tracked.txt');
    git(['add', '-f', '_site-foo/tracked.txt'], referenceDir);
    put(referenceDir, '_site-foo/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('_site-foo');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site-foo/stale.test.ts'))).toBe(true);
    expect(readFileSync(join(referenceDir, '_site-foo/tracked.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves ignored node_modules outside the build naming convention', () => {
    put(referenceDir, 'node_modules/keep.js');
    put(referenceDir, '_site-visual-fixtures/stale.test.ts');
    cleanIgnoredBuildOutput(referenceDir);
    expect(existsSync(join(referenceDir, '_site-visual-fixtures/stale.test.ts'))).toBe(false);
    expect(readFileSync(join(referenceDir, 'node_modules/keep.js'), 'utf8')).toBe('keep\n');
  });

  it('refuses build outputs when Git eligibility evidence is unavailable', () => {
    put(base, '.gitignore', '_site-x/\n');
    put(base, '_site-x/keep.txt');
    expect(() => ignoredBuildOutputDirs(base)).toThrow();
    expect(() => cleanIgnoredBuildOutput(base)).toThrow(expect.objectContaining({
      message: expect.stringContaining('ignored build output cleanup failed'),
      ignoredBuildOutputCleanupFailure: true,
    }));
    expect(existsSync(join(base, '_site-x/keep.txt'))).toBe(true);
  });

  it('does not follow an output symlink outside the lane', () => {
    put(base, 'outside/keep.test.ts');
    symlinkSync(join(base, 'outside'), join(referenceDir, '_site-visual-fixtures'));
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(base, 'outside/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site-visual-fixtures'))).toBe(true);
  });

  for (const command of ['acquire', 'refresh']) {
    it.each([['clean', 1], ['ls-files', 1], ['ls-files', 128], ['check-ignore', 128]])(
      `surfaces %s exit %i as cleanup failure on ${command} without a corruption retry`, (probe, exitCode) => {
      const lane = provision();
      put(lane, '_site/stale.test.ts');
      const bin = join(base, 'bin');
      const attempts = join(base, 'cleanup-attempts');
      // Fail only this cleanup operation; every other Git operation uses the real binary.
      put(bin, 'git', `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes(${JSON.stringify(probe)}) &&
    args.includes(${JSON.stringify(probe === 'clean' ? '-fdX' : '_site/')})) {
  appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
  process.stderr.write('fatal: bad object cleanup probe\\n');
  process.exit(${exitCode});
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
