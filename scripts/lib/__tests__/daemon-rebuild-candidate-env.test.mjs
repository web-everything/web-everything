import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateSmokeEnv } from '../daemon-rebuild/candidate.mjs';
import { scrubGitRepoEnv } from '../lane-git-hardening.mjs';

let root;
const origin = 'https://example.com/project.git';
function git(args) {
  execFileSync('git', args, { cwd: root, env: scrubGitRepoEnv(process.env), timeout: 10_000 });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'candidate-smoke-env-'));
  git(['init', '--quiet']);
  git(['remote', 'add', 'origin', origin]);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('candidateSmokeEnv canonical origin', () => {
  it('carries the live root origin despite inherited Git location and config overrides', () => {
    const env = {
      GIT_DIR: join(root, 'missing.git'), GIT_WORK_TREE: join(root, 'missing'),
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'remote.origin.url',
      GIT_CONFIG_VALUE_0: 'https://example.com/wrong.git',
    };
    expect(candidateSmokeEnv({ root, env }).LANE_POOL_CANONICAL_ORIGIN).toBe(origin);
    expect(env.LANE_POOL_CANONICAL_ORIGIN).toBeUndefined();
  });

  it.each(['https://example.com/explicit.git', ''])('keeps an already-set env value (%j)', value => {
    expect(candidateSmokeEnv({ root, env: { LANE_POOL_CANONICAL_ORIGIN: value } })
      .LANE_POOL_CANONICAL_ORIGIN).toBe(value);
  });

  it('leaves the env unset when the root has no origin', () => {
    git(['remote', 'remove', 'origin']);
    expect(candidateSmokeEnv({ root, env: {} }).LANE_POOL_CANONICAL_ORIGIN).toBeUndefined();
  });

  it('does not throw when the root is unreadable', () => {
    expect(candidateSmokeEnv({ root: join(root, 'missing'), env: {} })
      .LANE_POOL_CANONICAL_ORIGIN).toBeUndefined();
  });
});
