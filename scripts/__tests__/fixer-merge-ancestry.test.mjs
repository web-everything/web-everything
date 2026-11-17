import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rebaseDropManifest } from '../lib/rebase-drop-manifest.mjs';
import { ROOT } from './fixtures/check-standards-rules-fixtures.mjs';

// PR #3253, read-only observation 2026-10-01: the PR endpoint's base.sha
// 6eea4909 produced 128 files / +5619 -775; compare/main...95cb2165 had
// five unique commits and nine files. The 13:02 push was a8ecbc88b (two
// ordinary fixes on dfc9aa12c); 21f12b0b at 13:12 had parents ef097d284
// (real main) and a8ecbc88b. No recreated upstream commits in that graph.
// This fixture distinguishes an old comparison base from rewritten history.
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(baseRef = 'main') {
  const root = mkdtempSync(join(tmpdir(), 'we-merge-ancestry-'));
  roots.push(root);
  const git = (...args) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  const commit = (file, text) => {
    writeFileSync(join(root, file), text);
    git('add', file);
    git('commit', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  const oldBase = commit('shared.txt', 'original\n');
  git('branch', 'lane/test');
  if (baseRef !== 'main') git('checkout', '-b', baseRef);
  const upstream = Array.from({ length: 6 }, (_, i) => commit(`main-${i}.txt`, `main ${i}\n`));
  const base = git('rev-parse', 'HEAD');
  git('checkout', 'lane/test');
  const own = commit('repair.txt', 'repair\n');
  git('remote', 'add', 'origin', root);
  return { root, git, commit, oldBase, base, own, upstream };
}

describe('fixer catch-up preserves ancestry and comparison scope', () => {
  for (const brief of ['fix-agent-brief.md', 'fix-agent-ci-brief.md']) {
    for (const baseRef of ['main', 'lane/parent']) {
      it(`${brief}: executes the published merge recipe against ${baseRef}`, () => {
        const f = fixture(baseRef);
        const body = readFileSync(join(ROOT, 'skills-src/conveyor', brief), 'utf8');
        const recipe = [...body.matchAll(/```bash\n([\s\S]*?)```/g)]
          .map((m) => m[1]).find((code) => code.startsWith('BASE_REF='));
        expect(recipe).toBeTruthy();
        // Only the read-only GitHub base lookup is replaced; fetch/merge/check are real git.
        execFileSync('bash', ['-c', `gh() { echo '${baseRef}'; }\n${recipe}`], {
          cwd: f.root, stdio: 'pipe', env: { ...process.env, GIT_MERGE_AUTOEDIT: 'no' },
        });
        expect(f.git('show', '-s', '--format=%P', 'HEAD').split(' ')).toEqual([f.own, f.base]);
        expect(f.git('diff', `${f.base}...HEAD`)).toBe(f.git('diff', f.base, 'HEAD'));
        expect(f.git('diff', '--name-only', `${f.base}...HEAD`)).toBe('repair.txt');
        for (const sha of f.upstream) expect(f.git('merge-base', '--is-ancestor', sha, 'HEAD')).toBe('');
        expect(f.git('diff', '--name-only', `${f.oldBase}...HEAD`).split('\n')).toHaveLength(7);
      });
    }
  }

  it('the drain helper already creates a real merge, strips the manifest, and retains original commits', () => {
    const f = fixture();
    f.commit('.lane-manifest.json', '{}\n');
    const tip = f.git('rev-parse', 'HEAD');
    // A bare local destination avoids pushing to a checked-out branch; no GitHub writes.
    const bare = join(f.root, 'remote.git');
    f.git('clone', '--bare', f.root, bare);
    f.git('remote', 'set-url', 'origin', bare);
    const r = rebaseDropManifest({ laneRef: 'lane/test', base: f.base, cwd: f.root });
    expect(r.action).toBe('rebased');
    expect(f.git('show', '-s', '--format=%P', r.newCommit).split(' ')).toEqual([f.base, tip]);
    expect(f.git('diff', '--name-only', `${f.base}...${r.newCommit}`)).toBe('repair.txt');
    expect(f.git('diff', `${f.base}...${r.newCommit}`)).toBe(f.git('diff', f.base, r.newCommit));
    expect(f.git('diff', '--name-only', `${f.oldBase}...${r.newCommit}`).split('\n')).toHaveLength(7);
    expect(f.git('rev-parse', 'refs/remotes/origin/lane/test')).toBe(r.newCommit);
  });
});
