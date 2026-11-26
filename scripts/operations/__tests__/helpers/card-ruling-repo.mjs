import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Real objects and graph; the injected fetch port refreshes refs without network IO. */
export function cardRepo() {
  const root = mkdtempSync(join(tmpdir(), 'card-ruling-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' },
  });
  const put = (path, content = 'fixture\n') => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  git('init', '-b', 'main');
  put('backlog/100-existing.md', '---\nstatus: open\n---\nExisting\n'); put('scripts/existing.mjs');
  git('add', '.'); git('commit', '-m', 'baseline');
  const baseline = git('rev-parse', 'HEAD').trim();
  const fetchMain = () => { git('update-ref', 'refs/remotes/origin/main', main); writeFileSync(join(root, '.git/FETCH_HEAD'), `${main}\t\tbranch 'main' of fixture\n`); };
  let main = baseline;
  fetchMain();
  const commit = () => { git('add', '-A'); git('commit', '--allow-empty', '-m', 'fixture change'); return git('rev-parse', 'HEAD').trim(); };
  return { root, git, put, baseline, fetchMain, commit, setMain: sha => { main = sha; }, close: () => rmSync(root, { recursive: true, force: true }) };
}
