/** @file Stale candidate-worktree reclaim + worktree-add error message (live 2026-10-26, wev-fix-daemon). */
import { afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { basename, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { reclaimStaleCandidates, materializeCandidate, candidateWorktreePath } from '../daemon-rebuild/candidate.mjs';
import { cloneKey } from '../daemon-overlays.mjs';
import { readRebuildState, rebuildStatePath, writeRebuildState } from '../daemon-rebuild/state.mjs';
import { ACTIVE_BUILD_TOKENS, claimBuildLease } from '../daemon-rebuild/lease.mjs';

const ROOT = '/nonexistent/clone';
const STATE = mkdtempSync(join(tmpdir(), 'stale-cand-'));
const ENV = { WE_DAEMON_STATE_DIR: STATE, HOME: '/nonexistent/home' };
const own = (token) => candidateWorktreePath(ROOT, ENV, token);
const porcelain = (entries) => entries.map((e) => [`worktree ${e.path}`, 'HEAD abc', 'detached', ...(e.locked ? [`locked${e.reason ? ` ${e.reason}` : ''}`] : [])].join('\n')).join('\n\n') + '\n';

function recordLease(path, overrides = {}) {
  const token = basename(path).slice(`${cloneKey(ROOT)}.candidate-`.length);
  writeRebuildState(ROOT, { building: { path, token, pid: Number(token.split('-')[0]), host: hostname(), ...overrides } }, ENV);
}

beforeEach(() => writeRebuildState(ROOT, { building: null }, ENV));
afterAll(() => rmSync(STATE, { recursive: true, force: true }));

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
    recordLease(dead);
    const { run, calls } = fakeGit([{ path: ROOT }, { path: dead, locked: true, reason: 'initializing' }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([dead]);
    expect(calls).toContain(`worktree unlock ${dead}`);
    expect(calls).toContain(`worktree remove --force ${dead}`);
    expect(calls.filter((c) => c.includes('remove')).length).toBe(1);
  });
  it('never touches a live owner', () => {
    const p = own('123-aa');
    recordLease(p);
    const { run, calls } = fakeGit([{ path: p, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => true, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('never touches an unknown owner (liveness probe unsure, or unparseable pid)', () => {
    const a = own('123-aa'); const b = own('manual-deadbeef');
    recordLease(a);
    const { run, calls } = fakeGit([{ path: a, locked: true }, { path: b, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => null, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it.each([
    ['another host', { host: `${hostname()}-other` }],
    ['a missing host', { host: undefined }],
    ['another candidate path', { path: own('456-bb') }],
    ['a mismatched pid', { pid: 456 }],
  ])('preserves a candidate with %s even when its pid is absent locally', (_label, overrides) => {
    const dead = own('123-aa');
    recordLease(dead, overrides);
    const { run, calls } = fakeGit([{ path: dead, locked: true }]);
    const pidAlive = vi.fn(() => false);
    const rm = vi.fn();
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive, rm });
    expect(r.reclaimed).toEqual([]);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it.each(['missing', 'corrupt'])('preserves a candidate with %s lease evidence', (kind) => {
    const dead = own('123-aa');
    if (kind === 'missing') rmSync(rebuildStatePath(ROOT, ENV));
    else writeFileSync(rebuildStatePath(ROOT, ENV), '{');
    const { run, calls } = fakeGit([{ path: dead, locked: true }]);
    const pidAlive = vi.fn(() => false);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(pidAlive).not.toHaveBeenCalled();
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('reclaims a same-host dead owner with a trailing-slash state directory', () => {
    const env = { ...ENV, WE_DAEMON_STATE_DIR: `${STATE}/` };
    const dead = candidateWorktreePath(ROOT, env, '123-aa');
    recordLease(dead);
    const { run, calls } = fakeGit([{ path: dead, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([dead]);
    expect(calls).toContain(`worktree unlock ${dead}`);
    expect(calls).toContain(`worktree remove --force ${dead}`);
  });
  it('never touches another clone prefix, an unlocked worktree, or a non-candidate path', () => {
    const other = join(STATE, `${cloneKey('/some/other')}.candidate-1-aa`);
    const unlocked = own('2-bb');
    recordLease(unlocked);
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
    recordLease(dead);
    const { run } = fakeGit([{ path: dead, locked: true }], { failOn: { prefix: 'worktree unlock', stderr: 'nope' } });
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(r.skipped[0]).toMatchObject({ path: dead });
  });
});

describe('reclaim honesty', () => {
  it('never reclaims a nested path that only embeds this clone prefix in a parent dir name', () => {
    const nested = join(STATE, `${cloneKey(ROOT)}.candidate-manual-parent`, `${cloneKey('/some/other')}.candidate-123-aa`);
    recordLease(nested);
    const { run, calls } = fakeGit([{ path: nested, locked: true }]);
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(calls.some((c) => c.includes('unlock') || c.includes('remove'))).toBe(false);
  });
  it('does not report reclaimed when git remove fails', () => {
    const dead = own('7-dd');
    recordLease(dead);
    const { run } = fakeGit([{ path: dead, locked: true }], { failOn: { prefix: 'worktree remove', stderr: 'busy' } });
    const r = reclaimStaleCandidates({ root: ROOT, run, env: ENV, pidAlive: () => false, rm: () => {} });
    expect(r.reclaimed).toEqual([]);
    expect(r.skipped[0].why).toMatch(/remove-failed: busy/);
  });
});

describe('materializeCandidate', () => {
  it.each([
    ['same-host dead owner', {}, false, true],
    ['foreign host', { host: `${hostname()}-other` }, false, false],
    ['missing host', { host: undefined }, false, false],
    ['live owner', {}, true, false],
    ['unknown owner', {}, null, false],
  ])('lease takeover preserves reclaim evidence for a %s', (_label, overrides, alive, shouldReclaim) => {
    const dead = own('80466-851559f8');
    recordLease(dead, { startedAt: '2000-01-01T00:00:00.000Z', ...overrides });
    const calls = [];
    let registered = true;
    let locked = true;
    const run = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'worktree' && args[1] === 'list') {
        return { status: 0, stdout: porcelain(registered ? [{ path: dead, locked }] : []), stderr: '' };
      }
      if (args[0] === 'worktree' && args[1] === 'unlock' && args[2] === dead) {
        expect(readRebuildState(ROOT, ENV).building.path).toBe(dead);
        locked = false;
      }
      if (args[0] === 'worktree' && args[1] === 'remove' && args[3] === dead) {
        if (locked) return { status: 1, stdout: '', stderr: 'fatal: worktree is locked' };
        registered = false;
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      expect(pid).toBe(80466);
      if (alive === true) return true;
      throw Object.assign(new Error('owner probe'), { code: alive === false ? 'ESRCH' : 'EPERM' });
    });
    let lease;
    try {
      const state = readRebuildState(ROOT, ENV);
      lease = claimBuildLease({ state, plan: { finalSha: 'abc', inputsKey: 'inputs' }, root: ROOT, run, env: ENV, nowMs: Date.now() });
      expect(lease).not.toBeNull();
      writeRebuildState(ROOT, state, ENV);
      const r = materializeCandidate({ root: ROOT, sha: 'abc', run, env: ENV, path: lease.path, pidAlive: () => alive, rm: () => {} });
      expect(r.ok).toBe(true);
      expect(readRebuildState(ROOT, ENV).building.token).toBe(lease.token);
      expect(calls.includes(`worktree unlock ${dead}`)).toBe(shouldReclaim);
      expect(registered).toBe(!shouldReclaim);
      if (shouldReclaim) {
        expect(calls.indexOf(`worktree unlock ${dead}`)).toBeLessThan(calls.indexOf(`worktree remove --force ${dead}`));
      }
    } finally {
      kill.mockRestore();
      if (lease) ACTIVE_BUILD_TOKENS.delete(lease.token);
    }
  });
  it('preserves a foreign-host candidate while materializing a new attempt', () => {
    const dead = own('80466-851559f8');
    recordLease(dead, { host: `${hostname()}-other` });
    const { run, calls } = fakeGit([{ path: dead, locked: true }]);
    const rm = vi.fn();
    const path = own('1-ff');
    const r = materializeCandidate({ root: ROOT, sha: 'abc', run, env: ENV, path, pidAlive: () => false, rm });
    expect(r).toMatchObject({ ok: true, path, reclaimed: [] });
    expect(calls).not.toContain(`worktree unlock ${dead}`);
    expect(calls).not.toContain(`worktree remove --force ${dead}`);
    expect(rm).not.toHaveBeenCalledWith(dead, expect.anything());
    expect(calls).toContain(`worktree add --detach --quiet ${path} abc`);
  });
  it('reclaims before adding and reports it via log', () => {
    const dead = own('80466-851559f8');
    recordLease(dead);
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
