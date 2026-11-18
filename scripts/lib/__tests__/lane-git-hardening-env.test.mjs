import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laneGitHardeningEnv } from '../lane-git-hardening.mjs';

describe('laneGitHardeningEnv replacement-object isolation', () => {
  it.each([undefined, { credentialPins: false }])('disables replacement objects with options %j', options => {
    expect(laneGitHardeningEnv({}, options).GIT_NO_REPLACE_OBJECTS).toBe('1');
  });

  it.each([undefined, { credentialPins: false }])('overrides inherited replacement-object settings with options %j', options => {
    const inherited = { GIT_NO_REPLACE_OBJECTS: '0' };
    expect(laneGitHardeningEnv(inherited, options).GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(inherited.GIT_NO_REPLACE_OBJECTS).toBe('0');
  });
});

// PR #7012 self-review: replace refs are not the only lane-owned parent rewrite. A lane's `info/grafts` file still forges
// parents under GIT_NO_REPLACE_OBJECTS, and its commit-graph file supplies parents too (index-pack never checks either:
// they are not objects). A card-only proof walking `rev-list --parents` in the lane must see the real parents.
describe('laneGitHardeningEnv lane-owned parent metadata', () => {
  const identity = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
  const hermetic = () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-graft-'));
    const empty = join(dir, 'empty-config');
    writeFileSync(empty, '');
    return { dir, base: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', ...identity } };
  };
  const git = (cwd, env, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  it.each([undefined, { credentialPins: false }])('ignores a lane info/grafts parent forgery with options %j', options => {
    const { dir, base } = hermetic();
    try {
      const lane = join(dir, 'lane');
      git(dir, base, ['init', '-q', lane]);
      const commit = msg => { git(lane, base, ['commit', '-q', '--allow-empty', '-m', msg]); return git(lane, base, ['rev-parse', 'HEAD']); };
      const oldHead = commit('old head'), hidden = commit('hidden code commit'), cardOnly = commit('card-only');
      writeFileSync(join(lane, '.git', 'info', 'grafts'), `${cardOnly} ${oldHead}\n`);
      // Positive control: without the hardening env the graft really skips the hidden commit.
      expect(git(lane, { ...base, GIT_NO_REPLACE_OBJECTS: '1' }, ['rev-list', '--parents', '-1', cardOnly])).toBe(`${cardOnly} ${oldHead}`);
      const env = laneGitHardeningEnv(base, options);
      expect(git(lane, env, ['rev-list', '--parents', '-1', cardOnly])).toBe(`${cardOnly} ${hidden}`);
      expect(git(lane, env, ['rev-list', `${oldHead}..${cardOnly}`]).split('\n')).toEqual([cardOnly, hidden]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([undefined, { credentialPins: false }])('never reads a lane commit-graph, even when lane config enables it, with options %j', options => {
    const { dir, base } = hermetic();
    try {
      const lane = join(dir, 'lane');
      git(dir, base, ['init', '-q', lane]);
      git(lane, base, ['config', '--local', 'core.commitGraph', 'true']);
      const env = laneGitHardeningEnv(base, options);
      expect(git(lane, env, ['config', '--get', 'core.commitGraph'])).toBe('false');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('pins the graft file even over an inherited one', () => {
    expect(laneGitHardeningEnv({ GIT_GRAFT_FILE: '/lane/info/grafts' }).GIT_GRAFT_FILE).toBe('/dev/null');
  });
});
