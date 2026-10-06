import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CI_HEAL_SALVAGE_ENV, SALVAGE_REFLOG_TAIL_BYTES_ENV, salvageEnabled,
  parseReflogSalvageCandidates, laneDirsForRepo, findSalvageCommit, pushSalvage } from '../ci-heal-salvage.mjs';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'ci-heal-salvage-')); dirs.push(dir); return dir; };
const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 });
function run(dir, ...args) { const r = git(dir, args); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); }
function fixture() {
  const root = temp(), origin = join(root, 'origin.git'), laneDir = join(root, 'lane-1');
  run(root, 'init', '--bare', origin);
  run(root, 'clone', origin, laneDir);
  run(laneDir, 'config', 'user.email', 'test@example.com');
  run(laneDir, 'config', 'user.name', 'Test');
  run(laneDir, 'config', 'commit.gpgsign', 'false');
  run(laneDir, 'checkout', '-b', 'lane/x');
  const commit = message => { run(laneDir, 'commit', '--allow-empty', '-m', message); return run(laneDir, 'rev-parse', 'HEAD'); };
  const head = commit('base');
  run(laneDir, 'push', 'origin', 'HEAD:refs/heads/lane/x');
  const sha = commit('PR #7: ci-heal — fix');
  run(laneDir, 'reset', '--hard', head);
  return { origin, laneDir, head, sha, commit };
}
const row = (sha, message) => `${'0'.repeat(40)} ${sha} Test <test@example.com> 1 +0000\t${message}\n`;

it('defaults on, with an explicit disable switch', () => {
  expect(CI_HEAL_SALVAGE_ENV).toBe('WE_CIHEAL_SALVAGE');
  expect(SALVAGE_REFLOG_TAIL_BYTES_ENV).toBe('WE_CIHEAL_SALVAGE_REFLOG_BYTES');
  expect(salvageEnabled({})).toBe(true);
  expect(salvageEnabled({ WE_CIHEAL_SALVAGE: '0' })).toBe(false);
});
it('parses only matching PR commit messages, newest first and deduplicated', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
  const text = row(a, 'commit: PR #3895: ci-heal — fix') + row(c, 'commit: PR #38950: ci-heal — wrong')
    + row(c, 'reset: PR #3895: ci-heal') + row(c, 'commit: PR #3895: ci-healer')
    + row(c, 'commit: unrelated') + row(b, 'commit (amend): PR #3895: ci-heal — amend')
    + row(a, 'commit: PR #3895: ci-heal — fix');
  expect(parseReflogSalvageCandidates(text, 3895)).toEqual([a, b]);
});
it('lists only sorted lane directories and tolerates missing pools', () => {
  const poolRoot = temp();
  for (const name of ['lane-2', 'lane-1', 'other']) mkdirSync(join(poolRoot, 'repo', name), { recursive: true });
  writeFileSync(join(poolRoot, 'repo', 'lane-file'), '');
  expect(laneDirsForRepo({ poolRoot, poolName: 'repo' })).toEqual(['lane-1', 'lane-2'].map(n => join(poolRoot, 'repo', n)));
  expect(laneDirsForRepo({ poolRoot, poolName: 'missing' })).toEqual([]);
});
it('does not spawn git without candidates and never throws on unavailable lanes', () => {
  const probe = vi.fn();
  expect(findSalvageCommit({ pr: 7, headRefOid: 'h', laneDirs: ['missing'], readTail: () => '', git: probe })).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  expect(findSalvageCommit({ pr: 7, headRefOid: 'h', laneDirs: ['missing'], readTail: () => { throw Error('offline'); }, git: probe })).toBeNull();
});
describe('real git salvage', () => {
  it('finds a commit surviving only in the reflog after reset', () => {
    const f = fixture();
    expect(findSalvageCommit({ pr: 7, headRefOid: f.head, laneDirs: [f.laneDir] })).toEqual({ sha: f.sha, laneDir: f.laneDir });
    vi.stubEnv(SALVAGE_REFLOG_TAIL_BYTES_ENV, '1');
    expect(findSalvageCommit({ pr: 7, headRefOid: f.head, laneDirs: [f.laneDir] })).toBeNull();
  });
  it('rejects a candidate that does not descend from the current head', () => {
    const f = fixture(); const current = f.commit('new PR work');
    expect(findSalvageCommit({ pr: 7, headRefOid: current, laneDirs: [f.laneDir] })).toBeNull();
  });
  it('rejects the current head itself', () => {
    const f = fixture();
    expect(findSalvageCommit({ pr: 7, headRefOid: f.sha, laneDirs: [f.laneDir] })).toBeNull();
  });
  it('prefers a qualifying tip even when its ancestor appears later in the reflog', () => {
    const f = fixture(); run(f.laneDir, 'reset', '--hard', f.sha);
    const tip = f.commit('PR #7: ci-heal — second fix');
    expect(findSalvageCommit({ pr: 7, headRefOid: f.head, laneDirs: [f.laneDir],
      readTail: () => row(tip, 'commit: PR #7: ci-heal') + row(f.sha, 'commit: PR #7: ci-heal') })).toEqual({ sha: tip, laneDir: f.laneDir });
  });
  it('pushes the recovered SHA and refuses non-fast-forward updates without force', () => {
    const f = fixture();
    expect(pushSalvage({ ...f, headRefName: 'lane/x' }).ok).toBe(true);
    expect(run(f.origin, 'rev-parse', 'refs/heads/lane/x')).toBe(f.sha);
    const divergent = f.commit('PR #7: ci-heal — divergent');
    const probe = vi.fn(git);
    expect(pushSalvage({ sha: divergent, laneDir: f.laneDir, headRefName: 'lane/x', git: probe }).ok).toBe(false);
    expect(probe).toHaveBeenCalledWith(f.laneDir, ['push', 'origin', `${divergent}:refs/heads/lane/x`]);
    expect(run(f.origin, 'rev-parse', 'refs/heads/lane/x')).toBe(f.sha);
  });
});

it.each(['3990', '#3990'])('recognizes item-backed brief titles for PR %s', number => {
  const sha = 'a'.repeat(40);
  expect(parseReflogSalvageCandidates(row(sha, `commit: WE #123: ci-heal — x (PR ${number})`), 3990)).toEqual([sha]);
  expect(parseReflogSalvageCandidates(row(sha, `commit (amend): WE #123: ci-heal — x (PR ${number})`), 3990)).toEqual([sha]);
});
it.each(['39900', '399', '#39900', '#399'])('rejects item-backed titles for another PR %s', number => {
  expect(parseReflogSalvageCandidates(row('a'.repeat(40), `commit: WE #123: ci-heal — x (PR ${number})`), 3990)).toEqual([]);
});
