/**
 * @file scripts/lib/__tests__/daemon-load-overlay.test.mjs
 * @description #3383 — the operator's manual "load this early" CLI, gated through the SAME merge → live-smoke →
 *   adopt/rollback path as `daemon-self-sync.mjs#withSelfSync`.
 *
 * Follow-up fix (found in live use, 2026-09-24): the first cut passed `--ref` straight through as
 * `selfSyncCheckout`'s own `base` — which checks "is HEAD on `base`?" — so `--ref=lane/xkse05k-...` made it
 * refuse `not-on-main` even though the clone WAS correctly on `main`, no fetch/merge ever attempted. The
 * operator loaded by hand instead, hit a real conflict, and their own manual rollback didn't fire (`git
 * merge --abort` never ran) — the clone sat mid-merge. `mergeOverlayRef` below fixes this: `homeBranch` (must
 * already be checked out) and `ref` (what gets fetched/merged) are independent parameters, and a conflict is
 * ALWAYS aborted before the function returns.
 *
 * `runDaemonLoadOverlay`'s wiring tests inject `merge`/`gate`/`readHead` — no real git, no real child process.
 * `mergeOverlayRef`/`dryRunOverlay`'s own tests inject `run` (git) — proving the ACTUAL git sequence, including
 * one REAL-git suite (temp repos) for the conflict-abort behavior, since that is exactly the live bug.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runDaemonLoadOverlay, mergeOverlayRef, dryRunOverlay } from '../daemon-load-overlay.mjs';

describe('runDaemonLoadOverlay — wiring (injected merge/gate/readHead)', () => {
  it('requires --clone', async () => {
    await expect(runDaemonLoadOverlay({ clone: null, ref: 'lane/x' })).rejects.toThrow(/--clone/);
  });

  it('requires --ref', async () => {
    await expect(runDaemonLoadOverlay({ clone: '/some/clone', ref: null })).rejects.toThrow(/--ref/);
  });

  it('nothing to merge (e.g. up to date) → reports it, gate is never called', async () => {
    const gate = vi.fn();
    const merge = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    const readHead = vi.fn(() => 'sha');
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', merge, gate, readHead });
    expect(result).toMatchObject({ mergedAnything: false, adopted: false, reason: 'up-to-date' });
    expect(gate).not.toHaveBeenCalled();
  });

  it('a conflict is reported like any other non-merge — never leaves anything for the gate to see', async () => {
    const gate = vi.fn();
    const merge = vi.fn(() => ({ merged: false, commits: 0, reason: 'conflict' }));
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', merge, gate, readHead: vi.fn(() => 'sha') });
    expect(result).toMatchObject({ mergedAnything: false, adopted: false, reason: 'conflict' });
    expect(gate).not.toHaveBeenCalled();
  });

  it('merged + gate adopts → adopted:true, reason and commit count passed through', async () => {
    const merge = vi.fn(() => ({ merged: true, commits: 5, reason: 'merged' }));
    const gate = vi.fn(async () => ({ adopt: true, reason: 'smoke-pass', smoke: { pass: true } }));
    const readHead = vi.fn(() => 'pre-sha');
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', merge, gate, readHead });
    expect(result).toMatchObject({ mergedAnything: true, adopted: true, commits: 5, reason: 'smoke-pass' });
  });

  it('merged + gate rejects → adopted:false, the rollback/smoke detail is surfaced', async () => {
    const merge = vi.fn(() => ({ merged: true, commits: 2, reason: 'merged' }));
    const gate = vi.fn(async () => ({ adopt: false, reason: 'smoke-fail', smoke: { pass: false, results: [{ name: 'gh-api-repo', ok: false }] } }));
    const readHead = vi.fn(() => 'pre-sha');
    const result = await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', merge, gate, readHead });
    expect(result.adopted).toBe(false);
    expect(result.reason).toBe('smoke-fail');
    expect(result.smoke.results[0].name).toBe('gh-api-repo');
  });

  it('the gate receives the PRE-merge HEAD (read before merge runs) as its rollback target', async () => {
    const order = [];
    const readHead = vi.fn(() => { order.push('readHead'); return 'pre-sha-xyz'; });
    const merge = vi.fn(() => { order.push('merge'); return { merged: true, commits: 1, reason: 'merged' }; });
    const gate = vi.fn(async (o) => { order.push('gate'); return { adopt: true, reason: 'ok', ...o }; });
    await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/x', merge, gate, readHead });
    expect(order).toEqual(['readHead', 'merge', 'gate']);
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ preMergeSha: 'pre-sha-xyz' }));
  });

  it('defaults the home branch to main, and forwards it as homeBranch (NEVER as ref) to merge', async () => {
    const merge = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({ clone: '/some/clone', ref: 'lane/xkse05k-gh-app-shim-401-fallback', merge, gate: vi.fn(), readHead: vi.fn(() => 'x') });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ homeBranch: 'main', ref: 'lane/xkse05k-gh-app-shim-401-fallback' }));
  });

  it('an explicit --base is forwarded as homeBranch, distinct from --ref (the exact live bug)', async () => {
    const merge = vi.fn(() => ({ merged: false, commits: 0, reason: 'up-to-date' }));
    await runDaemonLoadOverlay({ clone: '/some/clone', base: 'lane/daemon-poc', ref: 'lane/xkse05k-gh-app-shim-401-fallback', merge, gate: vi.fn(), readHead: vi.fn(() => 'x') });
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({ homeBranch: 'lane/daemon-poc', ref: 'lane/xkse05k-gh-app-shim-401-fallback' }));
  });

  it('--dry-run never calls merge or gate at all', async () => {
    const merge = vi.fn();
    const gate = vi.fn();
    const result = await runDaemonLoadOverlay({
      clone: '/some/clone', ref: 'lane/x', dryRun: true, merge, gate,
    });
    expect(merge).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });
});

describe('mergeOverlayRef — injected git', () => {
  const runner = (overrides = {}) => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      const key = args[0] === 'rev-list' ? 'rev-list' : args[0];
      const r = overrides[key];
      if (typeof r === 'function') return r(args);
      return r ?? { status: 0, stdout: key === 'symbolic-ref' ? 'main\n' : key === 'rev-list' ? '2\n' : '' };
    };
    return { run, calls };
  };

  it('on the home branch, clean, behind → fetches and merges the OVERLAY ref, not the home branch', () => {
    const { run, calls } = runner();
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/xkse05k-gh-app-shim-401-fallback', run });
    expect(r).toEqual({ merged: true, commits: 2, reason: 'merged' });
    expect(calls).toContain('fetch --quiet -- origin lane/xkse05k-gh-app-shim-401-fallback');
    expect(calls.some((c) => c.startsWith('merge origin/lane/xkse05k-gh-app-shim-401-fallback'))).toBe(true);
  });

  it('THE LIVE BUG: on `main` (the home branch), overlaying a DIFFERENT ref is never refused as not-on-base', () => {
    const { run } = runner(); // symbolic-ref reports 'main' by default
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/some-other-branch', homeBranch: 'main', run });
    expect(r.reason).not.toBe('not-on-base');
    expect(r.merged).toBe(true);
  });

  it('NOT on the home branch → not-on-base, never fetches', () => {
    const { run, calls } = runner({ 'symbolic-ref': { status: 0, stdout: 'some-other-branch\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', homeBranch: 'main', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'not-on-base' });
    expect(calls.some((c) => c.startsWith('fetch'))).toBe(false);
  });

  it('a dirty tree never reaches fetch or merge', () => {
    const { run, calls } = runner({ status: { status: 0, stdout: ' M file.txt\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r.reason).toBe('dirty');
    expect(calls.some((c) => c.startsWith('fetch') || c.startsWith('merge'))).toBe(false);
  });

  it('a merge CONFLICT is ALWAYS aborted before returning — never left mid-merge', () => {
    const { run, calls } = runner({ merge: (args) => (args[1] === '--abort' ? { status: 0, stdout: '' } : { status: 1, stdout: '', stderr: 'CONFLICT' }) });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(calls).toContain('merge --abort');
  });

  it('already up to date on the overlay ref → reports it, never merges', () => {
    const { run, calls } = runner({ 'rev-list': { status: 0, stdout: '0\n' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'up-to-date' });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it.each(['fetch', 'symbolic-ref', 'status'])('a failed/timed-out `%s` fails closed, never reaching merge', (site) => {
    const { run, calls } = runner({ [site]: { status: null, stdout: '', stderr: '', signal: 'SIGKILL' } });
    const r = mergeOverlayRef({ root: '/x', ref: 'lane/x', run });
    expect(r.merged).toBe(false);
    expect(['head-failed', 'status-failed', 'fetch-failed']).toContain(r.reason);
    expect(calls.some((c) => c.startsWith('merge') && !c.includes('--abort'))).toBe(false);
  });

  it('a `--ref` that looks like a git option is refused before any git runs (argv injection)', () => {
    expect(() => mergeOverlayRef({ root: '/x', ref: '--upload-pack=touch /tmp/pwned;', run: () => ({ status: 0, stdout: '' }) })).toThrow(/not a safe branch name/);
  });
});

describe('dryRunOverlay — injected git, never merges', () => {
  it('reports onHome/dirty/behind without ever calling merge', () => {
    const calls = [];
    const run = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'main\n' };
      if (args[0] === 'status') return { status: 0, stdout: '' };
      if (args[0] === 'fetch') return { status: 0, stdout: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: '3\n' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
      return { status: 0, stdout: '' };
    };
    const r = dryRunOverlay({ root: '/x', ref: 'lane/x', run });
    expect(r).toEqual({ onHome: true, dirty: false, fetched: true, behind: 3, headSha: 'deadbeef', wouldMerge: true });
    expect(calls.some((c) => c.startsWith('merge'))).toBe(false);
  });

  it('not on home branch → wouldMerge:false, still read-only', () => {
    const run = (args) => {
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'some-other\n' };
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
      return { status: 0, stdout: '' };
    };
    const r = dryRunOverlay({ root: '/x', ref: 'lane/x', run });
    expect(r.onHome).toBe(false);
    expect(r.wouldMerge).toBe(false);
  });
});

describe('mergeOverlayRef / dryRunOverlay — REAL git (temp repos), proving the conflict-abort fix live', () => {
  let dir;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = (cwd, file, text) => { writeFileSync(join(cwd, file), text); git(cwd, 'add', file); git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `edit ${file}`); };
  const realRun = (args, opts) => {
    try { return { status: 0, stdout: execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { ...opts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }; }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-'));
    git(dir, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
    git(dir, 'clone', '-q', 'origin.git', 'upstream');
    const up = join(dir, 'upstream');
    git(up, 'checkout', '-q', '-b', 'main');
    commit(up, 'a.txt', 'one\n');
    git(up, 'push', '-q', 'origin', 'main');
    // an overlay branch, diverged from main with its own commit
    git(up, 'checkout', '-q', '-b', 'lane/overlay');
    commit(up, 'overlay.txt', 'overlay side\n');
    git(up, 'push', '-q', 'origin', 'lane/overlay');
    git(up, 'checkout', '-q', 'main');
    // the daemon clone — stays on `main` throughout, exactly like the real incident
    git(dir, 'clone', '-q', '-b', 'main', 'origin.git', 'daemon');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a clean overlay merges into `main` while the clone stays ON `main` the whole time', () => {
    const d = join(dir, 'daemon');
    const r = mergeOverlayRef({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(r).toEqual({ merged: true, commits: 1, reason: 'merged' });
    expect(git(d, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main');
    expect(git(d, 'ls-files')).toContain('overlay.txt');
    expect(git(d, 'status', '--porcelain').trim()).toBe('');
  });

  it('a CONFLICTING overlay is aborted — HEAD and the tree are exactly as before, never left mid-merge', () => {
    const d = join(dir, 'daemon');
    commit(d, 'overlay.txt', 'conflicting local content\n'); // conflicts with the overlay branch's own overlay.txt
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const r = mergeOverlayRef({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(r).toEqual({ merged: false, commits: 0, reason: 'conflict' });
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore);
    expect(git(d, 'status', '--porcelain').trim()).toBe(''); // NOT mid-merge — this is the live bug, fixed
    expect(existsSync(join(d, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('--dry-run reports a real fetch + real ahead/behind count with NO merge ever attempted', () => {
    const d = join(dir, 'daemon');
    const headBefore = git(d, 'rev-parse', 'HEAD').trim();
    const preview = dryRunOverlay({ root: d, ref: 'lane/overlay', homeBranch: 'main', run: realRun });
    expect(preview.onHome).toBe(true);
    expect(preview.dirty).toBe(false);
    expect(preview.fetched).toBe(true);
    expect(preview.behind).toBe(1);
    expect(preview.wouldMerge).toBe(true);
    expect(git(d, 'rev-parse', 'HEAD').trim()).toBe(headBefore); // untouched
    expect(git(d, 'ls-files')).not.toContain('overlay.txt'); // not merged
  });
});
