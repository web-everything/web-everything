import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { numberPendingHashes, numberingCommitIdentityArgs } from '../lane-drain.mjs';
import { drainNumberedPairs } from '../lib/queue-branch-numbering.mjs';

function fixture({ mainAuthor }) {
  const cwd = mkdtempSync(join(tmpdir(), 'numbering-identity-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q'); git('config', 'commit.gpgsign', 'false');
  git('config', 'user.name', 'New Clone'); git('config', 'user.email', 'new@clone');
  mkdirSync(join(cwd, 'backlog'));
  mkdirSync(join(cwd, '.claude/skills/batch-backlog-items'), { recursive: true });
  writeFileSync(join(cwd, 'backlog/010-old.md'), '---\nstatus: resolved\n---\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  if (mainAuthor) {
    writeFileSync(join(cwd, 'backlog/009-older.md'), '---\nstatus: resolved\n---\n');
    git('add', '.');
    git('-c', `user.name=${mainAuthor[0]}`, '-c', `user.email=${mainAuthor[1]}`, 'commit', '-qm', 'drain: JIT-number xold000→#9 at land (#2288)');
  }
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n');
  git('add', '.'); git('commit', '-qm', 'card');
  return { cwd, git };
}

it('#5777/#5779: an untrusted clone identity numbers as the identity main already trusts, so CI exempts the pair', () => {
  const { cwd, git } = fixture({ mainAuthor: ['Established Drain', 'drain@main'] });
  try {
    expect(numberPendingHashes(cwd).committed).toBe(true);
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('Established Drain <drain@main>\n');
    expect([...drainNumberedPairs({ cwd })]).toEqual(['xabc123→11']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('keeps the clone identity when main already trusts it', () => {
  const { cwd, git } = fixture({ mainAuthor: ['New Clone', 'new@clone'] });
  try {
    expect(numberingCommitIdentityArgs(cwd)).toEqual([]);
    numberPendingHashes(cwd);
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('New Clone <new@clone>\n');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('keeps the clone identity when main has no numbering history (no identity is invented)', () => {
  const { cwd } = fixture({ mainAuthor: null });
  try { expect(numberingCommitIdentityArgs(cwd)).toEqual([]); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

it('ignores a look-alike subject: only a full JIT-number subject on main counts as trusted', () => {
  const lines = ['Forger\0f@x\0drain: JIT-number nonsense', 'Real\0r@x\0drain: JIT-number xaaaaaa→#1 at land (#2288)'].join('\n');
  const git = (a) => (a[0] === 'log' ? lines : 'Clone <c@x> 1792569712 -0400');
  expect(numberingCommitIdentityArgs('/nowhere', { git })).toEqual(['--author=Real <r@x>']);
});

// Live replay: main as it stood at 2026-10-21T03:16Z (ffc517506), when #5779's numbering commit f076c85c6 by
// "Nicolas Gilbert" went red. Root cause: trustedDrainAuthors read only the newest 100 numbering commits
// (--max-count=100, removed on main by 37e2806ef/3ac633cf1); all 100 were by "test", so the identity's 487
// older numbering commits did not count. Replay both: the capped read distrusted it; the uncapped read the
// identity helper uses trusts it, so the drain keeps the clone identity and CI exempts the pair.
it('live replay #5779: the capped read distrusted the drain identity; the uncapped read trusts it', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const MAIN = 'ffc517506fb063053d78573e77c650164d8dfcc4';
  const real = (a) => { try { return execFileSync('git', a, { cwd: repo, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 }).trim(); } catch { return null; } };
  if (real(['cat-file', '-e', `${MAIN}^{commit}`]) === null) return; // shallow clone: replay unavailable
  const capped = real(['log', '--max-count=100', '--grep=^drain: JIT-number ', '--format=%an', MAIN]).split('\n');
  expect(capped.includes('Nicolas Gilbert')).toBe(false);
  const git = (a) => (a[0] === 'log' ? real(a.map((x) => (x === 'origin/main' ? MAIN : x)))
    : 'Nicolas Gilbert <nic.g.gilbert@gmail.com> 1792569712 -0400');
  expect(numberingCommitIdentityArgs(repo, { git })).toEqual([]);
  const fresh = (a) => (a[0] === 'log' ? git(a) : 'Brand New Clone <new@clone> 1792569712 -0400');
  expect(numberingCommitIdentityArgs(repo, { git: fresh })).toEqual([`--author=${real(['log', '-1', '--grep=^drain: JIT-number ', '--format=%an <%ae>', MAIN])}`]);
});

it('kill switch drain.numberingCommitIdentity=clone keeps the clone identity (today\'s behavior)', () => {
  const lines = 'Real\0r@x\0drain: JIT-number xaaaaaa→#1 at land (#2288)';
  const git = (a) => (a[0] === 'log' ? lines : 'Clone <c@x> 1792569712 -0400');
  expect(numberingCommitIdentityArgs('/nowhere', { git, setting: { value: 'clone', source: 'env' } })).toEqual([]);
  expect(numberingCommitIdentityArgs('/nowhere', { git, setting: { value: 'trusted', source: 'standard' } })).toEqual(['--author=Real <r@x>']);
});

it('Codex audit #5: the EFFECTIVE author decides — GIT_AUTHOR_* env beats user.* and the numbering commit still lands trusted', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'numbering-identity-env-'));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  const saved = { n: process.env.GIT_AUTHOR_NAME, e: process.env.GIT_AUTHOR_EMAIL };
  try {
    git('init', '-q'); git('config', 'commit.gpgsign', 'false');
    git('config', 'user.name', 'Established Drain'); git('config', 'user.email', 'drain@main');
    mkdirSync(join(cwd, 'backlog')); mkdirSync(join(cwd, '.claude/skills/batch-backlog-items'), { recursive: true });
    writeFileSync(join(cwd, 'backlog/009-older.md'), '---\nstatus: resolved\n---\n');
    git('add', '.'); git('commit', '-qm', 'drain: JIT-number xold000→#9 at land (#2288)');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n');
    git('add', '.'); git('commit', '-qm', 'card');
    process.env.GIT_AUTHOR_NAME = 'Env Override'; process.env.GIT_AUTHOR_EMAIL = 'env@override';
    expect(numberPendingHashes(cwd).committed).toBe(true);
    expect(git('log', '-1', '--format=%an <%ae>')).toBe('Established Drain <drain@main>\n');
  } finally {
    if (saved.n === undefined) delete process.env.GIT_AUTHOR_NAME; else process.env.GIT_AUTHOR_NAME = saved.n;
    if (saved.e === undefined) delete process.env.GIT_AUTHOR_EMAIL; else process.env.GIT_AUTHOR_EMAIL = saved.e;
    rmSync(cwd, { recursive: true, force: true });
  }
});
