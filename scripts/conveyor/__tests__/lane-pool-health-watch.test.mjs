/**
 * @file lane-pool-health-watch.test.mjs — `we:backlog/3568-*.md`'s periodic half. PURE logic tests for
 * `planLaneReap` / `summarizeHealth` + IO-shell tests over injected fakes (mirroring
 * `we:scripts/conveyor/__tests__/duplicate-pr-watch.test.mjs`'s own shape), plus a small real-git integration
 * check that a litter-only unleased lane is genuinely reaped on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DISABLE_ENV_VAR,
  planLaneReap,
  summarizeHealth,
  defaultListLaneStatus,
  defaultReadPorcelain,
  defaultIsLeasedNow,
  defaultTrimPool,
  watchLanePoolHealth,
  runLanePoolHealthWatch,
  resolveLanePoolRepoPath,
} from '../lane-pool-health-watch.mjs';

describe('planLaneReap — pure', () => {
  it('reaps an unleased lane whose entire porcelain output is allowlisted litter', () => {
    const plan = planLaneReap([
      { lane: 1, path: '/pool/lane-1', exists: true, leased: false, porcelain: '?? .commit-msg.txt\n?? .pr-body.md\n' },
    ]);
    expect(plan).toEqual([{ lane: 1, path: '/pool/lane-1', action: 'reap', toRemove: ['.commit-msg.txt', '.pr-body.md'] }]);
  });

  it('leaves a non-allowlisted dirty file untouched and reports it, even if litter sits alongside it', () => {
    const plan = planLaneReap([
      { lane: 2, path: '/pool/lane-2', exists: true, leased: false, porcelain: '?? .commit-msg.txt\n M file.txt\n' },
    ]);
    expect(plan).toEqual([{ lane: 2, path: '/pool/lane-2', action: 'leave-dirty', leaveDirty: ['file.txt'] }]);
  });

  it('never touches a LEASED lane, regardless of its dirty contents', () => {
    const plan = planLaneReap([
      { lane: 3, path: '/pool/lane-3', exists: true, leased: true, porcelain: '?? .commit-msg.txt\n M file.txt\n' },
    ]);
    expect(plan).toEqual([{ lane: 3, path: '/pool/lane-3', action: 'skip-leased' }]);
  });

  it('marks an already-clean unleased lane as already-clean, not reap', () => {
    const plan = planLaneReap([{ lane: 4, path: '/pool/lane-4', exists: true, leased: false, porcelain: '' }]);
    expect(plan).toEqual([{ lane: 4, path: '/pool/lane-4', action: 'already-clean' }]);
  });

  it('skips a lane index with no clone on disk', () => {
    expect(planLaneReap([{ lane: 5, exists: false }])).toEqual([]);
  });

  // #3568 — a failed porcelain read (`null`) must never read as clean.
  it('a lane whose porcelain read FAILED (null) is reported read-error, never already-clean/acquirable', () => {
    const plan = planLaneReap([{ lane: 6, path: '/pool/lane-6', exists: true, leased: false, porcelain: null }]);
    expect(plan).toEqual([{ lane: 6, path: '/pool/lane-6', action: 'read-error' }]);
  });

  it('an empty-string porcelain (genuinely clean) is NOT a read-error — still already-clean', () => {
    const plan = planLaneReap([{ lane: 7, path: '/pool/lane-7', exists: true, leased: false, porcelain: '' }]);
    expect(plan).toEqual([{ lane: 7, path: '/pool/lane-7', action: 'already-clean' }]);
  });

  it('tolerant of a null/undefined lanes list', () => {
    expect(planLaneReap(null)).toEqual([]);
    expect(planLaneReap(undefined)).toEqual([]);
  });
});

describe('summarizeHealth — pure', () => {
  it('counts leased / acquirable / dirtyUnleased — a `reap` action counts as acquirable only when it actually succeeded', () => {
    const lanes = [
      { lane: 1, exists: true, leased: false },
      { lane: 2, exists: true, leased: false },
      { lane: 3, exists: true, leased: true },
      { lane: 4, exists: false },
    ];
    const plan = [
      { lane: 1, action: 'reap' },
      { lane: 2, action: 'leave-dirty' },
    ];
    expect(summarizeHealth(lanes, plan, [1])).toEqual({ total: 3, leased: 1, acquirable: 1, dirtyUnleased: 1 });
  });

  it('already-clean lanes are acquirable even with an empty `reaped` list', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'already-clean' }];
    expect(summarizeHealth(lanes, plan, [])).toEqual({ total: 1, leased: 0, acquirable: 1, dirtyUnleased: 0 });
  });

  // #3568 — a lane whose reap call THREW must not read as acquirable just
  // because the pre-execution plan said `'reap'` — it stayed dirty on disk, and the health line must say so.
  it('a `reap` action that did NOT actually succeed (missing from `reaped`) counts as dirtyUnleased, not acquirable', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'reap' }];
    expect(summarizeHealth(lanes, plan, [])).toEqual({ total: 1, leased: 0, acquirable: 0, dirtyUnleased: 1 });
  });

  it('defaults `reaped` to empty — a bare 2-arg call never optimistically counts a reap as done (e.g. a dry-run report)', () => {
    const lanes = [{ lane: 1, exists: true, leased: false }];
    const plan = [{ lane: 1, action: 'reap' }];
    expect(summarizeHealth(lanes, plan)).toEqual({ total: 1, leased: 0, acquirable: 0, dirtyUnleased: 1 });
  });
});

describe('defaultListLaneStatus — argv shape (exec injected, no real subprocess)', () => {
  it('shells lane-pool.mjs status --json with no --repo when omitted', () => {
    let capturedCmd; let capturedArgv; let capturedOpts;
    const exec = (cmd, argv, opts) => { capturedCmd = cmd; capturedArgv = argv; capturedOpts = opts; return '{"repo":"web-everything","root":"/pool/web-everything","lanes":[]}'; };
    const out = defaultListLaneStatus({ exec, root: '/repo' });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json']);
    expect(capturedOpts.cwd).toBe('/repo');
    expect(out).toEqual({ repo: 'web-everything', root: '/pool/web-everything', lanes: [] });
  });

  it('appends --repo when given a raw path, unchanged', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: '/some/checkout' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json', '--repo=/some/checkout']);
  });

  // Live-caught 2026-09-22 (#3873's own first real daemon run, non-dry-run): a caller passing a SLUG — the
  // same convention every sibling repo-generic pass accepts — crashed every run, because this file forwarded
  // it unchanged into lane-pool.mjs's own PATH-only --repo flag.
  it('resolves a constellation SLUG to its real checkout path before shelling lane-pool.mjs', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: 'chalbert/plateau-app' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json', `--repo=${process.env.HOME}/workspace/plateau-app`]);
  });

  it('a WE slug appends NO --repo at all — WE has no fixed path, lane-pool.mjs defaults to the cwd toplevel', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{"lanes":[]}'; };
    defaultListLaneStatus({ exec, root: '/repo', repo: 'chalbert/web-everything' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'status', '--json']);
  });
});

describe('resolveLanePoolRepoPath', () => {
  it('a recognized slug resolves to that repo\'s real checkout path, $HOME expanded', () => {
    expect(resolveLanePoolRepoPath('chalbert/plateau-app', '/Users/x')).toBe('/Users/x/workspace/plateau-app');
    expect(resolveLanePoolRepoPath('chalbert/frontierui', '/Users/x')).toBe('/Users/x/workspace/frontierui');
  });
  it('the WE slug resolves to null (no fixed path — let lane-pool.mjs default to the cwd toplevel)', () => {
    expect(resolveLanePoolRepoPath('chalbert/web-everything', '/Users/x')).toBeNull();
  });
  it('an unrecognized value (already a path) passes through unchanged', () => {
    expect(resolveLanePoolRepoPath('/some/checkout', '/Users/x')).toBe('/some/checkout');
  });
  it('null/empty passes through as null', () => {
    expect(resolveLanePoolRepoPath(null)).toBeNull();
    expect(resolveLanePoolRepoPath('')).toBeNull();
  });
});

describe('defaultReadPorcelain', () => {
  it('returns the raw exec output', () => {
    const exec = () => '?? foo.txt\n';
    expect(defaultReadPorcelain('/lane-1', exec)).toBe('?? foo.txt\n');
  });
  it('returns null (not throw) on a git failure', () => {
    const exec = () => { throw new Error('not a git repo'); };
    expect(defaultReadPorcelain('/gone', exec)).toBeNull();
  });
});

// #4025 — the periodic SHRINK half wired in beside the existing periodic litter-reap pass.
describe('defaultTrimPool — argv shape (exec injected, no real subprocess)', () => {
  it('shells lane-pool.mjs trim --json with no --repo/--max/--dry-run when omitted', () => {
    let capturedCmd; let capturedArgv; let capturedOpts;
    const exec = (cmd, argv, opts) => { capturedCmd = cmd; capturedArgv = argv; capturedOpts = opts; return '{"repo":"web-everything","total":5,"max":60,"removed":[],"kept":[],"remaining":5,"overCap":0,"dryRun":false}'; };
    const out = defaultTrimPool({ exec, root: '/repo' });
    expect(capturedCmd).toBe('node');
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json']);
    expect(capturedOpts.cwd).toBe('/repo');
    expect(out).toEqual({ repo: 'web-everything', total: 5, max: 60, removed: [], kept: [], remaining: 5, overCap: 0, dryRun: false });
  });

  it('appends --repo, --max, --dry-run when given', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{}'; };
    defaultTrimPool({ exec, root: '/repo', repo: '/some/checkout', max: 20, dryRun: true });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json', '--repo=/some/checkout', '--max=20', '--dry-run']);
  });

  it('resolves a constellation slug the same way defaultListLaneStatus does', () => {
    let capturedArgv;
    const exec = (cmd, argv) => { capturedArgv = argv; return '{}'; };
    defaultTrimPool({ exec, root: '/repo', repo: 'chalbert/plateau-app' });
    expect(capturedArgv).toEqual(['/repo/scripts/lane-pool.mjs', 'trim', '--json', `--repo=${process.env.HOME}/workspace/plateau-app`]);
  });

  it('returns null (never throws) when the child fails', () => {
    const exec = () => { throw new Error('boom'); };
    expect(defaultTrimPool({ exec })).toBeNull();
  });

  it('returns null on unparsable JSON, rather than throwing', () => {
    const exec = () => 'not json';
    expect(defaultTrimPool({ exec })).toBeNull();
  });
});

describe('watchLanePoolHealth — IO shell over injected fakes', () => {
  it('reaps every unleased litter-only lane and reports the health line', () => {
    const listStatus = () => ({
      repo: 'web-everything',
      root: '/pool/web-everything',
      lanes: [
        { lane: 1, path: '/pool/web-everything/lane-1', exists: true, leased: false, clean: false },
        { lane: 2, path: '/pool/web-everything/lane-2', exists: true, leased: true, clean: false },
        { lane: 3, path: '/pool/web-everything/lane-3', exists: true, leased: false, clean: true },
      ],
    });
    const porcelains = { '/pool/web-everything/lane-1': '?? .commit-msg.txt\n' };
    const readPorcelain = (dir) => porcelains[dir] ?? '';
    const reapedDirs = [];
    const reap = (dir) => { reapedDirs.push(dir); return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null });
    expect(result.plan.find((p) => p.lane === 1)).toEqual({ lane: 1, path: '/pool/web-everything/lane-1', action: 'reap', toRemove: ['.commit-msg.txt'] });
    expect(result.plan.find((p) => p.lane === 2)).toEqual({ lane: 2, path: '/pool/web-everything/lane-2', action: 'skip-leased' });
    expect(result.plan.find((p) => p.lane === 3)).toEqual({ lane: 3, path: '/pool/web-everything/lane-3', action: 'already-clean' });
    expect(reapedDirs).toEqual(['/pool/web-everything/lane-1']);
    expect(result.reaped).toEqual([1]);
    expect(result.health).toEqual({ total: 3, leased: 1, acquirable: 2, dirtyUnleased: 0 });
  });

  it('never reads a LEASED lane\'s porcelain at all', () => {
    const listStatus = () => ({
      lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: true, clean: false }],
    });
    let readCalled = false;
    const readPorcelain = () => { readCalled = true; return '?? .commit-msg.txt\n'; };
    watchLanePoolHealth({ listStatus, readPorcelain, reap: () => {}, trimPool: () => null });
    expect(readCalled).toBe(false);
  });

  it('dry-run plans but never reaps', () => {
    const listStatus = () => ({
      lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }],
    });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    let reapCalled = false;
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap: () => { reapCalled = true; }, dryRun: true, trimPool: () => null });
    expect(reapCalled).toBe(false);
    expect(result.reaped).toEqual([]);
    expect(result.plan[0].action).toBe('reap');
    expect(result.dryRun).toBe(true);
  });

  it('one lane\'s reap failure does not stop the sweep from reaping the rest', () => {
    const listStatus = () => ({
      lanes: [
        { lane: 1, path: '/pool/lane-1', exists: true, leased: false },
        { lane: 2, path: '/pool/lane-2', exists: true, leased: false },
      ],
    });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const reap = (dir) => {
      if (dir === '/pool/lane-1') throw new Error('boom');
      return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true };
    };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null });
    expect(result.reaped).toEqual([2]);
  });
});

// #4025 — the trim wiring: watchLanePoolHealth calls trimPool once, forwards repo/root/max/dryRun, and merges
// its result onto `.trim`, all independent of whatever the litter-reap half above did that tick.
describe('watchLanePoolHealth — trim wiring (#4025)', () => {
  it('calls trimPool with repo/root/max/dryRun and merges its result onto .trim', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return { total: 10, max: 5, removed: [9, 10], kept: [], remaining: 8, overCap: 3, dryRun: false }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain: () => '', repo: 'chalbert/plateau-app', root: '/repo', trimMax: 5, trimPool });
    expect(captured).toEqual({ repo: 'chalbert/plateau-app', root: '/repo', max: 5, dryRun: false });
    expect(result.trim).toEqual({ total: 10, max: 5, removed: [9, 10], kept: [], remaining: 8, overCap: 3, dryRun: false });
  });

  it('forwards dryRun into trimPool too — a dry-run health-watch tick never lets trim actually remove anything', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return null; };
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', dryRun: true, trimPool });
    expect(captured.dryRun).toBe(true);
  });

  it('a null trim result (best-effort failure) is reported as .trim: null, never thrown', () => {
    const listStatus = () => ({ lanes: [] });
    const result = watchLanePoolHealth({ listStatus, readPorcelain: () => '', trimPool: () => null });
    expect(result.trim).toBeNull();
  });

  it('defaults trimMax to null when omitted — trim falls back to its own per-repo cap', () => {
    const listStatus = () => ({ lanes: [] });
    let captured;
    const trimPool = (o) => { captured = o; return null; };
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', trimPool });
    expect(captured.max).toBeNull();
  });
});

describe('runLanePoolHealthWatch — the entrypoint', () => {
  it(`${DISABLE_ENV_VAR} set to any value makes it a true no-op — no read, no reap, no report`, () => {
    let listStatusCalled = false;
    const listStatus = () => { listStatusCalled = true; return { lanes: [] }; };
    const result = runLanePoolHealthWatch({ env: { [DISABLE_ENV_VAR]: '1' }, listStatus });
    expect(result).toEqual({ disabled: true });
    expect(listStatusCalled).toBe(false);
  });

  it('runs normally when the env var is absent', () => {
    const listStatus = () => ({ lanes: [] });
    const result = runLanePoolHealthWatch({ env: {}, listStatus, trimPool: () => null });
    expect(result.disabled).toBeUndefined();
    expect(result.health).toEqual({ total: 0, leased: 0, acquirable: 0, dirtyUnleased: 0 });
  });

  // #3568 — "presence-checked, any value" must include an
  // EMPTY string, which a bare truthiness check on `env[DISABLE_ENV_VAR]` would treat as unset.
  it(`${DISABLE_ENV_VAR}='' (empty string) still disables — presence, not truthiness`, () => {
    let listStatusCalled = false;
    const listStatus = () => { listStatusCalled = true; return { lanes: [] }; };
    const result = runLanePoolHealthWatch({ env: { [DISABLE_ENV_VAR]: '' }, listStatus });
    expect(result).toEqual({ disabled: true });
    expect(listStatusCalled).toBe(false);
  });
});

describe('watchLanePoolHealth — TOCTOU guard (#3568)', () => {
  // `isLeasedNow` is now passed straight INTO `reap` (`cleanLaneLitter`'s own last-gate check), never checked
  // separately by this function beforehand — see `cleanLaneLitter`'s own docblock for why. This describe block
  // pins the PASS-THROUGH contract; `cleanLaneLitter`'s own real behavior for `isLeasedNow` is pinned in
  // `we:scripts/lib/__tests__/lane-litter.test.mjs`.
  it('passes isLeasedNow straight into reap, for every action:"reap" lane', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const isLeasedNow = () => false;
    let capturedArgs;
    const reap = (path, opts) => { capturedArgs = [path, opts]; return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, isLeasedNow, trimPool: () => null });
    expect(capturedArgs).toEqual(['/pool/lane-1', { isLeasedNow }]);
    expect(result.reaped).toEqual([1]);
  });

  it('a skipped outcome (reap declined — leased or real dirt raced in) is not counted as reaped', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    const reap = () => ({ removed: [], leaveDirty: [], skipped: true, complete: false });
    const result = watchLanePoolHealth({ listStatus, readPorcelain, reap, trimPool: () => null });
    expect(result.reaped).toEqual([]);
    // still PLANNED as 'reap' (the plan is a snapshot decision) — only the actual mutation was declined
    expect(result.plan[0].action).toBe('reap');
  });

  it('reap is never even called for a lane the plan did not mark for reap (already-clean)', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    let called = false;
    watchLanePoolHealth({ listStatus, readPorcelain: () => '', reap: () => { called = true; }, trimPool: () => null });
    expect(called).toBe(false);
  });

  it('counts a lane as reaped when reap succeeds (skipped:false)', () => {
    const listStatus = () => ({ lanes: [{ lane: 1, path: '/pool/lane-1', exists: true, leased: false }] });
    const readPorcelain = () => '?? .commit-msg.txt\n';
    let reapCalled = false;
    const result = watchLanePoolHealth({
      listStatus, readPorcelain, reap: () => { reapCalled = true; return { removed: ['.commit-msg.txt'], leaveDirty: [], skipped: false, complete: true }; },
      trimPool: () => null,
    });
    expect(reapCalled).toBe(true);
    expect(result.reaped).toEqual([1]);
  });
});

describe('defaultIsLeasedNow — real lease-marker read', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-lease-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('false when no marker exists', () => {
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });

  it('true for a fresh, live lease marker', () => {
    writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ session: 's', acquiredAt: new Date().toISOString() }));
    expect(defaultIsLeasedNow(dir)).toBe(true);
  });

  it('false for a TTL-expired (stale) lease marker — a dead holder is not a lease', () => {
    const acquiredAt = new Date(Date.now() - 10 * 864e5).toISOString(); // 10 days ago
    writeFileSync(join(dir, '.git', '.lane-lease'), JSON.stringify({ session: 's', acquiredAt }));
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });

  it('false (fail-open) for a corrupt marker', () => {
    writeFileSync(join(dir, '.git', '.lane-lease'), 'not json');
    expect(defaultIsLeasedNow(dir)).toBe(false);
  });
});

// ── Real-git integration: the same shared `cleanLaneLitter` core actually reaps on disk ──────────────────────
describe('watchLanePoolHealth — real git integration (proves the SAME shared cleanup fn is reused, not re-derived)', () => {
  let dir;
  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lane-pool-health-watch-'));
    git(['init', '--quiet'], dir);
    git(['config', 'user.email', 't@t.com'], dir);
    git(['config', 'user.name', 't'], dir);
    writeFileSync(join(dir, 'file.txt'), 'v1\n');
    git(['add', 'file.txt'], dir);
    git(['commit', '--quiet', '-m', 'v1'], dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reaps a real litter-only unleased lane on disk via the shared cleanLaneLitter core', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'WE #1: test\n');
    writeFileSync(join(dir, 'review-3568-output.json'), '{}\n');

    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    const result = watchLanePoolHealth({ listStatus, readPorcelain: defaultReadPorcelain, trimPool: () => null });

    expect(result.reaped).toEqual([1]);
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(false);
    expect(existsSync(join(dir, 'review-3568-output.json'))).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });

  it('leaves a real non-allowlisted dirty file on disk, reported not reaped', () => {
    writeFileSync(join(dir, 'notes.txt'), 'not on the allowlist\n');
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');

    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    const result = watchLanePoolHealth({ listStatus, readPorcelain: defaultReadPorcelain, trimPool: () => null });

    expect(result.reaped).toEqual([]);
    expect(result.plan[0].action).toBe('leave-dirty');
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true); // never partially reaped alongside real dirt
  });

  // #3568 — proved end-to-end: real dirt written AFTER the plan snapshot
  // but BEFORE the mutation must cancel the reap, via `cleanLaneLitter`'s own leaveDirty gate (armed whenever
  // `isLeasedNow` is passed) over its one fresh read — not a stale plan decision.
  it('a race — real dirt appears on disk between the snapshot and the reap call — cancels the reap, litter included', () => {
    writeFileSync(join(dir, '.commit-msg.txt'), 'litter\n');
    // The plan is built from THIS snapshot (pure litter) — but the injected `readPorcelain` simulates a
    // concurrent write landing on disk between the snapshot and the actual `reap()` call by writing the real
    // file itself at snapshot time, i.e. by the time `reap` (real `cleanLaneLitter`) takes its OWN fresh read,
    // the race has already "happened" on disk.
    const listStatus = () => ({ lanes: [{ lane: 1, path: dir, exists: true, leased: false }] });
    const readPorcelain = (d) => {
      const snapshot = defaultReadPorcelain(d);
      writeFileSync(join(dir, 'raced-in.txt'), 'a concurrent real edit\n'); // lands after the snapshot is taken
      return snapshot;
    };
    const result = watchLanePoolHealth({ listStatus, readPorcelain, trimPool: () => null });

    expect(result.plan[0].action).toBe('reap'); // the STALE plan still says reap — it saw only litter
    expect(result.reaped).toEqual([]); // but the actual mutation was cancelled by the fresh re-read
    expect(existsSync(join(dir, '.commit-msg.txt'))).toBe(true); // litter left in place too — never partial
    expect(existsSync(join(dir, 'raced-in.txt'))).toBe(true);
  });
});
