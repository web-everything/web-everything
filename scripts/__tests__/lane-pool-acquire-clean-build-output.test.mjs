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
  it('derives _site and _site-visual-fixtures from the real repository configurations', () => {
    // Remote test runners may not sync dotfiles; embed the exact real shape of the Eleventy return block instead.
    put(referenceDir, '.eleventy.js', '  return {\n    dir: {\n      input: "src",\n      output: "_site",\n      includes: "_includes",\n      layouts: "_layouts"\n    },\n  };\n');
    put(referenceDir, 'playwright.config.ts', readFileSync(resolve('playwright.config.ts'), 'utf8'));
    put(referenceDir, '_site/stale.test.ts');
    put(referenceDir, '_site-visual-fixtures/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).toEqual(['_site', '_site-visual-fixtures']);
  });

  it.each([
    ['chained backup command', 'command: `npx @11ty/eleventy && backup --output=backups`,'],
    ['inline comment', 'command: `npx @11ty/eleventy`, // --output=backups'],
    ['semicolon', 'command: `npx @11ty/eleventy --output=backups; backup`,'],
    ['pipe', 'command: `npx @11ty/eleventy --output=backups | backup`,'],
    ['shell comment', 'command: `npx @11ty/eleventy --output=backups # comment`,'],
    ['comment in flag value', 'command: `npx @11ty/eleventy --output=backups --url=http://example`,'],
    ['second command', 'command: `npx @11ty/eleventy --output=backups backup`,'],
    ['second property on line', 'command: `npx @11ty/eleventy --output=backups`, other: true,'],
    ['single quoted command', "command: 'npx @11ty/eleventy --output=backups',"],
  ])('preserves ignored backups for a Playwright %s', (_shape, config) => {
    put(referenceDir, '.gitignore', '_site/\nbackups/\n');
    put(referenceDir, 'playwright.config.ts', config);
    put(referenceDir, 'backups/keep.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('backups');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'backups/keep.test.ts'), 'utf8')).toBe('keep\n');
  });

  it.each([
    ['string literal', 'const example = \'dir: { output: "backups" }\';'],
    ['single line block', 'dir: { output: "backups" }'],
    ['inline opening', 'module.exports = { dir: {\noutput: "backups"\n}\n};'],
    ['inline closing', 'dir: {\noutput: "backups" }'],
    ['missing closing line', 'dir: {\noutput: "backups"\n'],
    ['output outside dir', 'output: "backups"\ndir: {\ninput: "src"\n}'],
    ['inline output property', 'dir: {\ninput: "src", output: "backups"\n}'],
    ['single quoted output string literal', 'dir: {\nconst example = \'output: "backups"\';\n}'],
  ])('preserves ignored backups for an Eleventy %s', (_shape, config) => {
    put(referenceDir, '.gitignore', 'backups/\n');
    put(referenceDir, '.eleventy.js', config);
    put(referenceDir, 'backups/keep.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('backups');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'backups/keep.test.ts'), 'utf8')).toBe('keep\n');
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

  it.each(['.eleventy.js', 'playwright.config.ts'])('refuses an ignored output containing tracked files from %s', (config) => {
    put(referenceDir, config, config === '.eleventy.js'
      ? eleventyConfig('tracked-output')
      : playwrightCommand('tracked-output'));
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
    put(referenceDir, 'playwright.config.ts', '// @11ty/eleventy --output=node_modules\nexport default {};\n');
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

  it.each(['//', '*', '/*'])('preserves ignored output named on a %s comment line', (prefix) => {
    put(referenceDir, '.gitignore', '_site/\ncomment-output/\n');
    put(referenceDir, 'playwright.config.ts', `  ${prefix} @11ty/eleventy --output=comment-output\n`);
    put(referenceDir, 'comment-output/keep.test.ts');
    put(referenceDir, '_site/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('comment-output');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'comment-output/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
  });

  it('preserves ignored output named in a non-Eleventy command string', () => {
    put(referenceDir, '.gitignore', '_site/\nunrelated-output/\n');
    put(referenceDir, 'playwright.config.ts', 'const command = `other-build --output=unrelated-output`;\n');
    put(referenceDir, 'unrelated-output/keep.test.ts');
    put(referenceDir, '_site/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).not.toContain('unrelated-output');
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'unrelated-output/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
  });

  it.each([
    '// dir: { output: "comment-output" }\n',
    '/*\ndir: { output: "comment-output" }\n*/\n',
  ])('preserves ignored output in an Eleventy comment %j', (comment) => {
    put(referenceDir, '.gitignore', '_site/\ncomment-output/\n');
    put(referenceDir, '.eleventy.js', comment + eleventyConfig('_site'));
    put(referenceDir, 'comment-output/keep.test.ts');
    put(referenceDir, '_site/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).toEqual(['_site']);
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'comment-output/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
  });

  it.each([
    'const commands = [`backup --output=backups`, `@11ty/eleventy --output=_site`];',
    'const commands = [`@11ty/eleventy --output=_site`, "backup --output=backups"];',
    'const command = `backup --output=backups && @11ty/eleventy --output=_site`;',
  ])('preserves ignored backups named outside the Eleventy output argument in %j', (config) => {
    put(referenceDir, '.gitignore', '_site/\nbackups/\n');
    put(referenceDir, 'playwright.config.ts', config);
    put(referenceDir, 'backups/keep.test.ts');
    put(referenceDir, '_site/stale.test.ts');
    expect(ignoredBuildOutputDirs(referenceDir)).toEqual(['_site']);
    cleanIgnoredBuildOutput(referenceDir);
    expect(readFileSync(join(referenceDir, 'backups/keep.test.ts'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(referenceDir, '_site/stale.test.ts'))).toBe(false);
  });

  it.each(['"', "'"])('preserves ignored backups when an Eleventy output string contains comment delimiters in %s quotes', (quote) => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', 'backups/\n');
    put(base, '.eleventy.js', `module.exports = {\n  dir: {\n    output: ${quote}back/*archive*/ups${quote}\n  }\n};`);
    put(base, 'backups/unrelated.txt');
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    cleanIgnoredBuildOutput(base);
    expect(existsSync(join(base, 'backups'))).toBe(true);
    expect(readFileSync(join(base, 'backups/unrelated.txt'), 'utf8')).toBe('keep\n');
  });

  it('preserves the ignored parent and unrelated files for a nested Playwright output path', () => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', 'backups/\n');
    put(base, 'playwright.config.ts', playwrightCommand('backups/site'));
    put(base, 'backups/site/stale.test.ts');
    put(base, 'backups/unrelated.txt');
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    cleanIgnoredBuildOutput(base);
    expect(existsSync(join(base, 'backups'))).toBe(true);
    expect(readFileSync(join(base, 'backups/site/stale.test.ts'), 'utf8')).toBe('keep\n');
    expect(readFileSync(join(base, 'backups/unrelated.txt'), 'utf8')).toBe('keep\n');
  });

  it('derives custom names from dir.output and every Playwright output, deduplicating them', () => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', 'custom-site/\nvisual-one/\nvisual-two/\n');
    put(base, '.eleventy.js', 'output: "unrelated",\n' + eleventyConfig('custom-site'));
    put(base, 'playwright.config.ts', ['visual-one', 'visual-two', 'visual-one'].map(playwrightCommand).join(''));
    for (const name of ['custom-site', 'visual-one', 'visual-two']) put(base, `${name}/stale.test.ts`);
    expect(ignoredBuildOutputDirs(base)).toEqual(['custom-site', 'visual-one', 'visual-two']);
  });

  it.each(['node_modules', '.git', '.claude', 'src', 'scripts', 'docs'])('refuses denylisted output %s from either config', (name) => {
    git(['init', '--quiet'], base);
    put(base, '.gitignore', `${name}/\n`);
    put(base, '.eleventy.js', eleventyConfig(name));
    put(base, 'playwright.config.ts', playwrightCommand(name));
    put(base, `${name}/keep.test.ts`);
    expect(ignoredBuildOutputDirs(base)).toEqual([]);
    cleanIgnoredBuildOutput(base);
    expect(readFileSync(join(base, name, 'keep.test.ts'), 'utf8')).toBe('keep\n');
  });

  it('refuses configured outputs when Git eligibility evidence is unavailable', () => {
    put(base, '.eleventy.js', eleventyConfig('output'));
    put(base, '.gitignore', 'output/\n');
    put(base, 'output/keep.txt');
    expect(() => ignoredBuildOutputDirs(base)).toThrow();
    expect(() => cleanIgnoredBuildOutput(base)).toThrow(expect.objectContaining({
      message: expect.stringContaining('ignored build output cleanup failed'),
      ignoredBuildOutputCleanupFailure: true,
    }));
    expect(existsSync(join(base, 'output/keep.txt'))).toBe(true);
  });

  it.each(['', '.', '..', '../outside', 'nested/output', '/absolute', '.hidden', 'a..b', 'a\\b', '*', ':(glob)*', '${output}'])('rejects unsafe output name %j', (name) => {
    put(base, '.eleventy.js', eleventyConfig(name));
    put(base, 'playwright.config.ts', playwrightCommand(name));
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
    put(base, '.eleventy.js', eleventyConfig('missing-output'));
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
