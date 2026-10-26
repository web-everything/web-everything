/** @file Stale candidate-worktree reclaim + worktree-add error message (live 2026-10-26, wev-fix-daemon). */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { reclaimStaleCandidates, materializeCandidate, candidateWorktreePath } from '../daemon-rebuild/candidate.mjs';
import { cloneKey } from '../daemon-overlays.mjs';

const ROOT = '/nonexistent/clone';
const STATE = mkdtempSync(join(tmpdir(), 'stale-cand-'));
const ENV = { WE_DAEMON_STATE_DIR: STATE, HOME: '/nonexistent/home' };
const own = (token) => candidateWorktreePath(ROOT, ENV, token);
const porcelain = (entries) => entries.map((e) => [`worktree ${e.path}`, 'HEAD abc', 'detached', ...(e.locked ? [`locked${e.reason ? ` ${e.reason}` : ''}`] : [])].join('\n')).join('\n\n') + '\n';

function fakeGit(entries, { failOn } = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args.join(' '));
    if (failOn && args.join(' ').startsWith(failOn.prefix)) return { status: failOn.status ?? 1, stdout: '', stderr: failOn.stderr ?? '' };
    if (args[0] === 'worktree' && args[1] === 'list') return { status: 0, stdout: porcelain(entries), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('reclaimStaleCandidates', () => {
  it('unlocks + removes (that path only) a locked own-clone candidate whose pid is dead, and nothing else', () => {
    const dead = own('80466-851559f8');
    const { run, calls } = fakeGit([{ path: ROOT }, { path: dead, locked: true, reason: 'initializing' }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([dead]);
    expect(calls).toContain(`worktree unlock ${dead}`);
    expect(calls).toContain(`worktree remove --force ${dead}`);
    expect(calls.filter((c) => c.includes('remove')).length).toBe(1);
  });
  it('never touches a live owner', () => {
    const p = own('123-aa');
    const { run, calls } = fakeGit([{ path: p, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => true, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('never touches an unknown owner (liveness probe unsure, or unparseable pid)', () => {
    const a = own('123-aa'); const b = own('manual-deadbeef');
    const { run, calls } = fakeGit([{ path: a, locked: true }, { path: b, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => null, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('never touches another clone prefix, an unlocked worktree, or a non-candidate path', () => {
    const other = join(STATE, `${cloneKey('/some/other')}.candidate-1-aa`);
    const unlocked = own('2-bb');
    const { run, calls } = fakeGit([{ path: other, locked: true }, { path: unlocked }, { path: '/nonexistent/lane', locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('fails closed when the worktree listing fails', () => {
    const { run, calls } = fakeGit([], { failOn: { prefix: 'worktree list' } });
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock'))).toBe(false);
  });
  it('skips (does not claim reclaimed) when unlock fails', () => {
    const dead = own('9-cc');
    const { run } = fakeGit([{ path: dead, locked: true }], { failOn: { prefix: 'worktree unlock', stderr: 'nope' } });
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ path: dead });
  });
});

describe('reclaim honesty', () => {
  it('never reclaims a nested path that only embeds this clone prefix in a parent dir name', () => {
    const nested = join(STATE, `${cloneKey(ROOT)}.candidate-manual-parent`, `${cloneKey('/some/other')}.candidate-123-aa`);
    const { run, calls } = fakeGit([{ path: nested, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('does not report reclaimed when git remove fails', () => {
    const dead = own('7-dd');
    const { run } = fakeGit([{ path: dead, locked: true }], { failOn: { prefix: 'worktree remove', stderr: 'busy' } });
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(r.skipped[0].why).toMatch(/remove-failed: busy/);
  });
});

describe('materializeCandidate', () => {
  it('reclaims before adding and reports it via log', () => {
    const dead = own('80466-851559f8');
    const { run, calls } = fakeGit([{ path: dead, locked: true }]);
    const lines = [];
    const r = materializeCandidate({ root: ROOT, sha: 'abc', run, env: ENV, path: own('1-ff'), pidAlive: () => false, rm: () => {}, log: { error: (m) => lines.push(m) } });
    expect(r.ok).toBe(true);
    expect(r.reclaimed).toEqual([dead]);
    expect(calls.findIndex((c) => c.startsWith('worktree unlock'))).toBeLessThan(calls.findIndex((c) => c.startsWith('worktree add')));
    expect(lines.join('\n')).toMatch(/reclaimed stale candidate worktree .*80466/);
  });
  it('worktree-add-failed carries git stderr', () => {
    const { run } = fakeGit([], { failOn: { prefix: 'worktree add', stderr: 'fatal: boom happened\nmore' } });
    const r = materializeCandidate({ root: ROOT, sha: 'abc', run, env: ENV, path: own('1-ff'), pidAlive: () => true, rm: () => {} });
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toBe('worktree-add-failed: fatal: boom happened');
  });
  it('worktree-add-failed is never empty when git printed nothing (timeout/kill)', () => {
    const { run } = fakeGit([], { failOn: { prefix: 'worktree add', status: 1, stderr: '' } });
    const r = materializeCandidate({ root: ROOT, sha: 'abc', run, env: ENV, path: own('1-ff'), pidAlive: () => true, rm: () => {} });
    expect(r.reason).toMatch(/^worktree-add-failed: .*\S/);
    expect(r.reason).toMatch(/no output/);
  });
});
