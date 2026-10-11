import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planWrongBranchHeal, healWrongBranch, parseTrackedChanges, resolveWrongBranchHealSettings } from '../daemon-rebuild/wrong-branch-heal.mjs';

const settings = { branches: ['ops/review-requests'], pathPrefixes: ['verdict-ledger/'] };
const mainSha = '536356170' + '0'.repeat(31);
const detachedCases = [
  { name: 'clean HEAD at main', headSha: mainSha, changedPaths: [], expected: { heal: true } },
  { name: 'tracked store change at main', headSha: mainSha, changedPaths: ['verdict-ledger/x'], expected: { heal: false, reason: 'detached-with-changes' } },
  { name: 'tracked non-store change at main', headSha: mainSha, changedPaths: ['scripts/x'], expected: { heal: false, reason: 'detached-with-changes' } },
  { name: 'HEAD off main', headSha: '1'.repeat(40), changedPaths: [], expected: { heal: false, reason: 'detached-off-main' } },
  { name: 'unreadable HEAD', headSha: null, changedPaths: [], expected: { heal: false, reason: 'detached-or-unreadable-head' } },
  { name: 'missing main', headSha: mainSha, hasMain: false, changedPaths: [], expected: { heal: false, reason: 'no-local-main' } },
  { name: 'unreadable status', headSha: mainSha, changedPaths: null, expected: { heal: false, reason: 'status-unreadable' } },
];
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete ENV[k];

function gitIn(cwd) {
  return (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
}

/** Replay of wev-review-daemon on 2026-10-09 06:55 ET: on the ledger branch, ledger file staged, untracked sidecars. */
function replayClone({ extraTracked = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-'));
  const g = gitIn(dir);
  g(['init', '--quiet', '-b', 'main']);
  mkdirSync(join(dir, 'skills-src/conveyor'), { recursive: true });
  writeFileSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'), 'export {};\n');
  writeFileSync(join(dir, '.gitignore'), '.conveyor/\n');
  g(['add', '.']); g(['commit', '--quiet', '-m', 'main']);
  g(['checkout', '--quiet', '--orphan', 'ops/review-requests']);
  g(['rm', '-r', '--quiet', '--cached', '.']);
  rmSync(join(dir, 'skills-src'), { recursive: true, force: true }); rmSync(join(dir, '.gitignore'));
  mkdirSync(join(dir, 'verdict-ledger'));
  writeFileSync(join(dir, 'verdict-ledger/web-everything-web-everything.jsonl'), '{"a":1}\n');
  g(['add', 'verdict-ledger']); g(['commit', '--quiet', '-m', 'verdict-ledger: append']);
  writeFileSync(join(dir, 'verdict-ledger/web-everything-web-everything.jsonl'), '{"a":1}\n{"b":2}\n');
  g(['add', 'verdict-ledger']);
  if (extraTracked) { writeFileSync(join(dir, 'other.txt'), 'x\n'); g(['add', 'other.txt']); }
  mkdirSync(join(dir, '.conveyor')); writeFileSync(join(dir, '.conveyor/review-daemon.log'), 'log\n');
  return { dir, g };
}

describe('planWrongBranchHeal (pure rule)', () => {
  it.each(detachedCases)('detached: $name', ({ headSha, changedPaths, hasMain = true, expected }) => {
    expect(planWrongBranchHeal({ branch: null, headSha, mainSha: hasMain ? mainSha : null, changedPaths, hasMain, settings })).toEqual(expected);
  });
  it('heals an allowlisted branch with only store changes', () => {
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: ['verdict-ledger/x.jsonl'], hasMain: true, settings })).toEqual({ heal: true });
  });
  it('refuses an unknown branch, a detached HEAD, a foreign change, no main, unreadable status', () => {
    expect(planWrongBranchHeal({ branch: 'feature/x', changedPaths: [], hasMain: true, settings }).reason).toBe('branch-not-allowlisted');
    expect(planWrongBranchHeal({ branch: null, changedPaths: [], hasMain: true, settings }).reason).toBe('detached-or-unreadable-head');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: ['scripts/a.mjs'], hasMain: true, settings }).reason).toBe('non-store-changes');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: [], hasMain: false, settings }).reason).toBe('no-local-main');
    expect(planWrongBranchHeal({ branch: 'ops/review-requests', changedPaths: null, hasMain: true, settings }).reason).toBe('status-unreadable');
  });
  it('parses renames as both paths', () => {
    expect(parseTrackedChanges('M  verdict-ledger/a\0R  b\0c\0')).toEqual(['verdict-ledger/a', 'b', 'c']);
  });
  it('settings: defaults when malformed, file values when valid', () => {
    expect(resolveWrongBranchHealSettings({ read: () => '{' })).toEqual(settings);
    expect(resolveWrongBranchHealSettings({ read: () => '{"wrongBranchHeal":{"branches":["ops/x"]}}' }).branches).toEqual(['ops/x']);
  });
});

describe('healWrongBranch (2026-10-11 detached drain-daemon clone)', () => {
  it.each(detachedCases)('detached IO: $name', ({ headSha, changedPaths, hasMain = true, expected }) => {
    const calls = [];
    const git = (args) => {
      calls.push(args);
      switch (args.join(' ')) {
        case 'symbolic-ref --short HEAD': return { status: 1, stdout: '' };
        case 'rev-parse --verify --quiet HEAD': return { status: headSha ? 0 : 1, stdout: headSha ? `${headSha}\n` : '' };
        case 'rev-parse --verify --quiet refs/heads/main': return { status: hasMain ? 0 : 1, stdout: hasMain ? `${mainSha}\n` : '' };
        case 'status --porcelain=v1 -z --untracked-files=no': return { status: changedPaths === null ? 1 : 0, stdout: (changedPaths ?? []).map((p) => ` M ${p}\0`).join('') };
        case 'checkout --quiet main': return { status: 0, stdout: '' };
        default: throw new Error(`Unexpected git command: ${args.join(' ')}`);
      }
    };
    expect(healWrongBranch({ git, settings })).toEqual(expected.heal
      ? { healed: true, from: `(detached at ${mainSha.slice(0, 9)})`, savedRef: null }
      : { healed: false, reason: expected.reason });
    expect(calls.filter(([cmd]) => cmd === 'checkout')).toEqual(expected.heal ? [['checkout', '--quiet', 'main']] : []);
  });

  it('reattaches a real clean detached HEAD at main without changing the commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wrong-branch-heal-detached-'));
    const g = gitIn(dir);
    try {
      expect(g(['init', '--quiet', '-b', 'main']).status).toBe(0);
      writeFileSync(join(dir, 'tracked.txt'), 'main\n');
      expect(g(['add', 'tracked.txt']).status).toBe(0);
      expect(g(['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'main']).status).toBe(0);
      const sha = g(['rev-parse', '--verify', '--quiet', 'HEAD']).stdout.trim();
      expect(g(['checkout', '--quiet', '--detach']).status).toBe(0);
      expect(g(['symbolic-ref', '--short', 'HEAD']).status).not.toBe(0);
      expect(healWrongBranch({ git: g, settings })).toEqual({ healed: true, from: `(detached at ${sha.slice(0, 9)})`, savedRef: null });
      expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('main');
      expect(g(['rev-parse', 'HEAD']).stdout.trim()).toBe(sha);
      expect(g(['status', '--porcelain=v1']).stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('healWrongBranch (replay of the 2026-10-09 review-daemon clone)', () => {
  it('saves the ledger change to a named ref, returns to main, restores the daemon entry, keeps untracked', () => {
    const { dir, g } = replayClone();
    expect(existsSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'))).toBe(false);
    const r = healWrongBranch({ git: g, settings, now: () => 42 });
    expect(r).toEqual({ healed: true, from: 'ops/review-requests', savedRef: 'refs/we/wrong-branch-heal/42' });
    expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('main');
    expect(existsSync(join(dir, 'skills-src/conveyor/review-daemon.mjs'))).toBe(true);
    expect(existsSync(join(dir, '.conveyor/review-daemon.log'))).toBe(true);
    expect(g(['show', 'refs/we/wrong-branch-heal/42:verdict-ledger/web-everything-web-everything.jsonl']).stdout).toContain('"b":2');
    rmSync(dir, { recursive: true, force: true });
  });
  it('still refuses when a non-store tracked file changed, and touches nothing', () => {
    const { dir, g } = replayClone({ extraTracked: true });
    const r = healWrongBranch({ git: g, settings });
    expect(r).toMatchObject({ healed: false, reason: 'non-store-changes' });
    expect(g(['symbolic-ref', '--short', 'HEAD']).stdout.trim()).toBe('ops/review-requests');
    expect(g(['diff', '--cached', '--name-only']).stdout).toContain('other.txt');
    rmSync(dir, { recursive: true, force: true });
  });
});
