// @vitest-environment node
import { expect, it } from 'vitest';
import { findRawPushes, isLintedScript } from '../lib/push-gate-lint.mjs';

it('refuses unreadable source and invalid syntax for manual inspection', () => {
  expect(() => findRawPushes(null)).toThrow(/unreadable source/);
  expect(() => findRawPushes('execSync(')).toThrow(/parse error/);
});

it('reports call lines and kinds once per call, including property helpers', () => {
  expect(findRawPushes("// ignored git push\ncp.spawn('git', ['push', 'push']);\nio['runGit']('git push');"))
    .toEqual([{ line: 2, kind: 'argv' }, { line: 3, kind: 'shell' }]);
});

it('distinguishes flag values from pushes following git global flags', () => {
  expect(findRawPushes("git('log', '--grep', 'push'); git(['log', '--author', 'push']);")).toEqual([]);
  expect(findRawPushes("git('-C', 'push'); git(['-c', 'push']);")).toHaveLength(2);
});

it('reads static template text without inventing command text across interpolation', () => {
  expect(findRawPushes('sh(`cd ${dir} && git -C x push`);')).toEqual([{ line: 1, kind: 'shell' }]);
  expect(findRawPushes('sh(`git ${verb}push`);')).toEqual([{ line: 1, kind: 'unresolved' }]);
});

it('excludes test suffixes and non-repository path spellings', () => {
  for (const path of ['scripts/x.test.mjs', 'scripts/x.soak.test.mjs', '/scripts/x.mjs',
    './scripts/x.mjs', 'scripts/../x.mjs', 'scripts/a\\b.mjs']) {
    expect(isLintedScript(path), path).toBe(false);
  }
});


it.each([
  "import { spawnSync as launch } from 'node:child_process'; launch('git', ['push']);",
  "import * as cp from 'child_process'; cp.execFile('git', ['push']);",
  "import cp from 'node:child_process'; cp['execSync']('git push');",
  "const { execFileSync: launch } = require('child_process'); launch('git', ['push']);",
  "const cp = require('node:child_process'); cp.spawn('git', ['push']);",
  "const launch = require('node:child_process').spawn; launch('git', ['push']);",
])('detects child_process import/require bindings: %s', source => {
  expect(findRawPushes(source)).toHaveLength(1);
});

it.each([
  "spawn('git', args);", "spawn('git', ['push', branch]);", "spawn('git', [...args]);", "spawn('git', ['status'].concat(args));",
  "spawn('git', [`${verb}`]);", "runGit(args);", "git(['-C', dir, `${verb}push`]);",
])('refuses unresolved git argv: %s', source => {
  expect(findRawPushes(source)).toEqual([{ line: 1, kind: 'unresolved' }]);
});

it.each([
  'spawn(`git`, [`push`]);',
  "spawn('git', ['--git-dir=/x', '--work-tree=/x', '-C/x', '-c', 'k=v', 'push']);",
  'execSync(\'"git" "push"\');',
  'execSync(\'git "push"\');',
])('detects static templates, attached global flags and quoted shell words: %s', source => {
  expect(findRawPushes(source)).toHaveLength(1);
});

it.each(['mjs', 'js', 'cjs', 'ts'])('scans non-test .%s scripts', ext => {
  expect(isLintedScript(`scripts/nested/source.${ext}`)).toBe(true);
  expect(isLintedScript(`scripts/source.test.${ext}`)).toBe(false);
  expect(isLintedScript(`scripts/source.spec.${ext}`)).toBe(false);
});
it('parses TypeScript with its source grammar', () => {
  expect(findRawPushes("const args: string[] = ['push']; spawn('git', args);", 'scripts/source.ts'))
    .toEqual([{ line: 1, kind: 'unresolved' }]);
});

it.each(['--git-dir=/x', '--work-tree=/x', '-C/x'])('detects push directly after attached global option %s', flag => {
  expect(findRawPushes(`spawn('git', ['${flag}', 'push']);`)).toEqual([{ line: 1, kind: 'argv' }]);
});
