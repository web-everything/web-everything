// @vitest-environment node
import { expect, it } from 'vitest';
import { findRawPushes, isLintedScript } from '../lib/push-gate-lint.mjs';

it('refuses unreadable source and invalid syntax for manual inspection', () => {
  expect(findRawPushes(null)).toEqual([{ line: 1, kind: 'unreadable-source' }]);
  expect(findRawPushes('execSync(')).toEqual([{ line: 1, kind: 'invalid-syntax' }]);
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
  expect(findRawPushes('sh(`git ${verb}push`);')).toEqual([]);
});

it('excludes test suffixes and non-repository path spellings', () => {
  for (const path of ['scripts/x.test.mjs', 'scripts/x.soak.test.mjs', '/scripts/x.mjs',
    './scripts/x.mjs', 'scripts/../x.mjs', 'scripts/a\\b.mjs', 'scripts/x.js']) {
    expect(isLintedScript(path), path).toBe(false);
  }
});
