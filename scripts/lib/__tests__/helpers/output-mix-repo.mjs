import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laneGitHardeningEnv, scrubInheritedGitEnv } from '../../lane-git-hardening.mjs';

/** A small real history, independent of the checkout's size, dates and Git configuration. */
export function outputMixRepo(root) {
  mkdirSync(root, { recursive: true });
  const env = { ...laneGitHardeningEnv(scrubInheritedGitEnv()),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Output fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Output fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (argv, date) => execFileSync('git', argv, {
    cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  git(['init', '--quiet']);
  for (const [date, files] of [
    ['2026-06-01T12:00:00Z', { 'src/old.njk': 'outside the window\n' }],
    ['2026-07-28T12:00:00Z', { 'src/previous.njk': 'previous product\n' }],
    ['2026-08-04T12:00:00Z', {
      'src/current.njk': 'product one\nproduct two\n',
      'scripts/current.mjs': 'machinery\n',
      'backlog/current.md': 'bookkeeping\n',
      'reports/current.md': 'other\n',
    }],
  ]) {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), contents);
    }
    git(['add', '--', ...Object.keys(files)]);
    git(['commit', '--quiet', '-m', 'output fixture'], date);
  }
  return root;
}
