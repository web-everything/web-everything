// @vitest-environment node
import { expect, it } from 'vitest';
import { findRawPushes, isLintedScript } from '../lib/push-gate-lint.mjs';
import { REPO_SCAN_TESTS } from '../lib/repo-scan-tests.mjs';

it.each([
  "execFileSync('echo', ['push']);",
  "execFileSync('echo', ['git push']);",
  "spawn('git push', []);",
  "import { execFileSync as launchGit } from 'child_process'; launchGit('echo', ['push']);",
  "execFileSync('git', ['checkout', 'push']);",
  "spawn('git', ['--no-pager', 'log', '--grep', 'push']);",
  "execSync('git --no-pager log --grep push');",
  "execSync('echo git push');",
  "execSync(\"echo 'git push'\");",
  "execSync('git -C \"push; repo\" checkout push');",
  "execFileSync('git', ['--version']);",
  "git(['--help']);",
  "git(['-C', 'push', 'checkout', 'push']);",
  "io.git({ cwd: dir, args: ['checkout', 'push'] });",
  "io.git({ cwd: dir, args: ['log', '--grep', 'push'] });",
  "gitExec({ file: '/usr/bin/python3', args: ['push'] });",
  "run(['checkout', 'push']);",
])('ignores push when it is not the Git subcommand: %s', source => {
  expect(findRawPushes(source)).toEqual([]);
});

it.each([
  "io.git({ cwd: dir, args: ['push', 'origin', 'HEAD'] });",
  "git({ args: ['-C', 'repo', 'push'], cwd: dir });",
  "io.git({ 'args': [`push`], cwd: dir });",
  "io.git({ ['args']: ['push'], cwd: dir });",
  "git(['push'], { cwd: dir });",
])('detects object-form Git push argv: %s', source => {
  expect(findRawPushes(source)).toEqual([{ line: 1, kind: 'argv' }]);
});

it.each([
  "io.git({ cwd: dir, args });",
  "io.git({ cwd: dir, args: ['push', branch] });",
  "io.git({ cwd: dir, args: [...args] });",
  "io.git({ args: ['status'], ...options });",
  "io.git({ ...options, args: ['push'] });",
])('refuses unresolved object-form Git argv: %s', source => {
  expect(findRawPushes(source)).toEqual([{ line: 1, kind: 'unresolved' }]);
});

it.each([
  "run(['push', '--porcelain', remote, ref]);",
  "runWt(['push', 'origin', ref], { cwd: dir });",
])('retains Git argv wrapper push sites: %s', source => {
  expect(findRawPushes(source)).toEqual([{ line: 1, kind: 'argv' }]);
});

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
  "spawn('/usr/bin/git', ['push']);",
  "spawn('C:\\\\tools\\\\git.exe', ['push']);",
  "execSync('/usr/bin/git --no-pager push');",
  "execSync('sh -c \"git push\"');",
  "spawn('/bin/bash', ['-lc', 'git --no-pager push']);",
  "spawn('git', ['--git-dir=/x', '--work-tree=/x', '-C/x', '-c', 'k=v', 'push']);",
  'execSync(\'"git" "push"\');',
  'execSync(\'git "push"\');',
])('detects static templates, attached global flags and quoted shell words: %s', source => {
  expect(findRawPushes(source)).toHaveLength(1);
});

it.each(['mjs', 'js', 'cjs', 'ts', 'mts', 'cts'])('scans non-test .%s scripts', ext => {
  expect(isLintedScript(`scripts/nested/source.${ext}`)).toBe(true);
  expect(isLintedScript(`scripts/source.test.${ext}`)).toBe(false);
  expect(isLintedScript(`scripts/source.spec.${ext}`)).toBe(false);
});
it.each(['ts', 'mts', 'cts'])('parses .%s with TypeScript source grammar', ext => {
  expect(findRawPushes("const args: string[] = ['push']; spawn('git', args);", `scripts/source.${ext}`))
    .toEqual([{ line: 1, kind: 'unresolved' }]);
});

it.each(['mjs', 'js', 'cjs', 'ts', 'mts', 'cts'])('shares filename-only test exclusions with scan selection for .%s', ext => {
  const scan = REPO_SCAN_TESTS.find(entry => entry.test === 'scripts/__tests__/push-gate-boundary.test.mjs');
  expect(scan.matches).toBe(isLintedScript);
  for (const path of [`scripts/task.test.data/worker.${ext}`, `scripts/task.spec.data/worker.${ext}`,
    `scripts/worker.test.data.${ext}`]) {
    expect(isLintedScript(path), path).toBe(true);
    expect(scan.matches(path), path).toBe(true);
  }
  expect(scan.matches(`scripts/task.test.data/worker.test.${ext}`)).toBe(false);
  expect(scan.matches(`scripts/task.spec.data/worker.spec.${ext}`)).toBe(false);
});

it('counts every push in one shell string and resets matching between strings and calls', () => {
  const source = "sh('git push && git -C repo push; git push'); sh('git status'); sh('git push');";
  expect(findRawPushes(source)).toEqual(Array.from({ length: 4 }, () => ({ line: 1, kind: 'shell' })));
  expect(findRawPushes(source)).toHaveLength(4);
});

it.each(['--git-dir=/x', '--work-tree=/x', '-C/x'])('detects push directly after attached global option %s', flag => {
  expect(findRawPushes(`spawn('git', ['${flag}', 'push']);`)).toEqual([{ line: 1, kind: 'argv' }]);
});
