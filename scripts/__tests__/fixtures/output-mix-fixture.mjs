/** Small, local Git history shared by the output-mix and board CLI regressions. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubInheritedGitEnv } from '../../lib/lane-git-hardening.mjs';

export function outputMixFixture(repoRoot) {
  mkdirSync(repoRoot, { recursive: true });
  const env = {
    ...scrubInheritedGitEnv(),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Output Mix Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Output Mix Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (argv, extraEnv = {}) => execFileSync('git', argv, {
    cwd: repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extraEnv },
  });
  git(['init', '--quiet']);
  const commit = (day, files) => {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(repoRoot, name)), { recursive: true });
      writeFileSync(join(repoRoot, name), contents);
    }
    git(['add', '--', ...Object.keys(files)]);
    const date = `${day}T12:00:00Z`;
    git(['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
      'commit', '--quiet', '-m', `output mix ${day}`], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  };

  // Sentinels on both sides ensure the five-week window excludes older and future output.
  commit('2026-06-29', { 'src/old.njk': 'old\n'.repeat(100) });
  const starts = ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03'];
  let product = '', machinery = '', other = '';
  starts.forEach((day, i) => {
    product += `product ${i}\n`.repeat(i + 1);
    machinery += `machinery ${i}\n`.repeat(2 * (i + 1));
    other += `other ${i}\n`.repeat(3 * (i + 1));
    commit(day, { 'src/output.njk': product, 'scripts/output.mjs': machinery, 'reports/output.md': other });
  });
  commit('2026-08-10', { 'src/future.njk': 'future\n'.repeat(100) });
  return { repoRoot, env };
}
