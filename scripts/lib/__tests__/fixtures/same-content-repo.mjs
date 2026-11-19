import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Real local history, with enough separation for main to shift a PR hunk mechanically. */
export function sameContentRepo(kind = 'clean') {
  const repo = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'same-content-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    WE_SAME_DIFF_CARRY: 'on', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  const commit = message => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const cleanup = () => rmSync(repo, { recursive: true, force: true });
  try {
    git('init', '-q', '-b', 'main');
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    write('code.js', lines); write('conflict.js', 'original\n'); write('scripts/ci/test-timings.json', '{"base":1}\n');
    write('backlog/xabc-story.md', 'same story\n'); write('outside/xabc-story.md', 'other story\n');
    write('sample.test.mjs', 'original test\n');
    const root = commit('base'); git('update-ref', 'refs/remotes/origin/main', root);
    git('checkout', '-qb', 'lane');
    write('code.js', lines.replace('line 75', 'PR line 75'));
    if (kind === 'conflict-test') write('scripts/ci/test-timings.json', '{"pr":2}\n');
    if (kind === 'conflict-code') write('conflict.js', 'PR conflict\n');
    const from = commit('PR change');
    let to;
    if (['clean', 'conflict-test', 'conflict-code'].includes(kind)) {
      git('checkout', '-q', 'main'); write('code.js', 'main prefix\nmain prefix two\n' + lines);
      if (kind === 'conflict-test') write('scripts/ci/test-timings.json', '{"main":3}\n');
      if (kind === 'conflict-code') write('conflict.js', 'main conflict\n');
      const main = commit('main advances'); git('update-ref', 'refs/remotes/origin/main', main);
      git('checkout', '-q', 'lane');
      try { git('merge', '--no-edit', 'main'); } catch (e) {
        if (!kind.startsWith('conflict-')) throw e;
        write(kind === 'conflict-test' ? 'scripts/ci/test-timings.json' : 'conflict.js', kind === 'conflict-test' ? 'resolved test\n'.repeat(8) : 'hand resolved\n');
        commit('resolved merge');
      }
      to = git('rev-parse', 'HEAD');
    } else if (kind.startsWith('jit') || kind === 'outside') {
      const dir = kind === 'outside' ? 'outside' : 'backlog';
      git('mv', `${dir}/xabc-story.md`, `${dir}/7456-story.md`);
      if (kind === 'jit-edit') write('backlog/7456-story.md', 'changed story\n');
      to = commit('JIT numbering');
    } else if (kind === 'octopus') {
      git('checkout', '-qb', 'side-one', root); write('side-one', '1'); const one = commit('side one');
      git('checkout', '-qb', 'side-two', root); write('side-two', '2'); const two = commit('side two');
      git('checkout', '-q', 'main'); git('merge', '--no-edit', one, two);
      git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
      git('checkout', '-q', 'lane'); const tree = git('rev-parse', `${from}^{tree}`);
      to = git('commit-tree', tree, '-p', from, '-p', one, '-p', two, '-m', 'octopus');
    } else {
      if (kind === 'test') write('sample.test.mjs', 'new test\n');
      else if (kind === 'mode') git('update-index', '--chmod=+x', 'sample.test.mjs');
      else write('code.js', 'new code\n');
      // commit -a would lose an index-only mode change; commit this index directly.
      if (kind === 'mode') { git('commit', '-qm', 'mode change'); to = git('rev-parse', 'HEAD'); }
      else to = commit('follow-up');
    }
    return { repo, env, git, write, commit, root, from, to, cleanup };
  } catch (e) { cleanup(); throw e; }
}
