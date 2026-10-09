/**
 * @file scripts/lib/__tests__/pr-snapshot.test.mjs
 * @description #gh-graphql-budget — the host-shared open-PR snapshot. Live 2026-09-27: ~10 daemons each ran their
 *   own `gh pr list --limit 200 --json …` for the same 3 repos every 1-2 min and exhausted the App installation's
 *   6100-points/hour GraphQL budget every hour. Proves: many readers with different field sets inside the TTL
 *   cost ONE right-sized fetch; a write (dirty marker) forces a refresh after the floor; a full page re-fetches
 *   larger; a failed fetch throws (never a silent double spend); tests/cwd repos are never served from disk; and
 *   every wired pass reader actually reads the snapshot instead of calling `gh`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, utimesSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSharedOpenPrs, nextLimit, isServable, projectPrs, SNAPSHOT_FIELDS, MIN_LIMIT, DIRTY_REFRESH_FLOOR_MS,
  readShaCache, writeShaCache, snapshotOpenCount,
} from '../pr-snapshot.mjs';
import { prSnapshotEnabled, markPrSnapshotDirty, repoFromGhArgs, snapshotPath, PR_SNAPSHOT_VERSION } from '../pr-snapshot-store.mjs';

const REPO = 'web-everything/web-everything';
const PRS = Array.from({ length: 14 }, (_, i) => ({
  number: 100 + i, title: `t${i}`, body: `b${i}`, url: `u${i}`, isDraft: false, createdAt: 'c', updatedAt: 'u',
  headRefName: `lane/x${i}`, headRefOid: `abc${i}`, baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }], files: [{ path: 'a.mjs' }], comments: [{ body: 'hi' }], statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }],
}));

function fakeExec(prs = PRS) {
  const calls = [];
  const exec = (file, argv) => {
    calls.push(argv);
    const limit = Number(argv[argv.indexOf('--limit') + 1]);
    return JSON.stringify(prs.slice(0, limit));
  };
  return { exec, calls };
}

let dir;
let clock;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pr-snapshot-')); clock = Date.parse('2026-09-27T06:00:00Z'); });
const opts = (extra = {}) => ({ repo: REPO, dir, now: () => clock, env: { VITEST: '1' }, ...extra });

describe('pure helpers', () => {
  it('nextLimit sizes the page to the real open count (+headroom), never below MIN_LIMIT', () => {
    expect(nextLimit(undefined)).toBe(MIN_LIMIT);
    expect(nextLimit(0)).toBe(MIN_LIMIT);
    expect(nextLimit(14)).toBe(MIN_LIMIT);
    expect(nextLimit(40)).toBe(50);
    expect(nextLimit(9999)).toBe(500);
  });
  it('isServable respects fields, TTL and the dirty floor', () => {
    const snap = { fields: ['number', 'labels'], fetchedAtMs: 1000 };
    expect(isServable(snap, { fields: ['number'], nowMs: 2000, ttlMs: 75_000 })).toBe(true);
    expect(isServable(snap, { fields: ['files'], nowMs: 2000, ttlMs: 75_000 })).toBe(false);
    expect(isServable(snap, { fields: ['number'], nowMs: 1000 + 75_000, ttlMs: 75_000 })).toBe(false);
    expect(isServable(snap, { fields: ['number'], nowMs: 2000, ttlMs: 75_000, dirtyMs: 1500 })).toBe(true); // inside the floor
    expect(isServable(snap, { fields: ['number'], nowMs: 1000 + DIRTY_REFRESH_FLOOR_MS, ttlMs: 75_000, dirtyMs: 1500 })).toBe(false);
  });
  it('projectPrs returns exactly the asked-for fields', () => {
    expect(projectPrs([{ number: 1, body: 'x', labels: [] }], ['number', 'labels'])).toEqual([{ number: 1, labels: [] }]);
  });
  it('repoFromGhArgs reads --repo / -R / --repo=', () => {
    expect(repoFromGhArgs(['pr', 'edit', '1', '--repo', 'o/n'])).toBe('o/n');
    expect(repoFromGhArgs(['pr', 'edit', '1', '-R', 'o/n'])).toBe('o/n');
    expect(repoFromGhArgs(['pr', 'edit', '--repo=o/n'])).toBe('o/n');
    expect(repoFromGhArgs(['pr', 'edit', '1'])).toBe(null);
  });
  it('is OFF under a test runner / fake gh unless a dir is named, and OFF on WE_PR_SNAPSHOT=0', () => {
    expect(prSnapshotEnabled({})).toBe(true);
    expect(prSnapshotEnabled({ VITEST: 'true' })).toBe(false);
    expect(prSnapshotEnabled({ FAKE_GH_FIXTURE: '/x' })).toBe(false);
    expect(prSnapshotEnabled({ VITEST: 'true', WE_PR_SNAPSHOT_DIR: '/x' })).toBe(true);
    expect(prSnapshotEnabled({ WE_PR_SNAPSHOT: '0', WE_PR_SNAPSHOT_DIR: '/x' })).toBe(false);
  });
});

describe('readSharedOpenPrs — one fetch serves the fleet', () => {
  it('8 readers with 8 different field sets inside the TTL cost ONE right-sized fetch (was 8 full lists)', () => {
    const { exec, calls } = fakeExec();
    const fieldSets = [
      'number,headRefName,headRefOid,baseRefName,labels,statusCheckRollup,mergeStateStatus,comments,body', // reconcile
      'number,labels,headRefOid,comments', // advisory / hold sweep
      'number,headRefName,headRefOid,statusCheckRollup', // ci-red-recovery
      'number,headRefName,headRefOid,statusCheckRollup,labels,baseRefName', // missing-run
      'number,headRefName,baseRefName,mergeable,mergeStateStatus,labels,files', // conflict watch
      'number,headRefName,headRefOid,labels,mergeable,isDraft,comments', // stuck-pr-watch
      'number,title,body,labels,statusCheckRollup,headRefName,headRefOid', // the drain's context listing
      'number,title,headRefName,labels,statusCheckRollup,updatedAt', // health-watch
    ];
    for (const fields of fieldSets) {
      const got = readSharedOpenPrs(opts({ fields, exec }));
      expect(got).toHaveLength(14);
      expect(Object.keys(got[0]).sort()).toEqual(fields.split(',').sort());
      clock += 5_000;
    }
    expect(calls).toHaveLength(1);
    const argv = calls[0];
    expect(argv.slice(0, 5)).toEqual(['pr', 'list', '--repo', REPO, '--state']);
    expect(argv[argv.indexOf('--limit') + 1]).toBe(String(MIN_LIMIT)); // 25, not 200: 1 GraphQL point, not 4
    expect(argv[argv.indexOf('--json') + 1]).toBe(SNAPSHOT_FIELDS.join(','));
  });

  it('refreshes after the TTL, sizing the next page from the last count', () => {
    const { exec, calls } = fakeExec();
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    clock += 80_000;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(calls).toHaveLength(2);
    expect(snapshotOpenCount(REPO, { dir })).toBe(14);
  });

  it('a full page re-fetches larger instead of silently truncating', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...PRS[0], number: i }));
    const { exec, calls } = fakeExec(many);
    const got = readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(got).toHaveLength(60);
    expect(calls.map((a) => a[a.indexOf('--limit') + 1])).toEqual(['25', '100']);
  });

  it('a write (dirty marker) forces a refresh once past the floor, not before', () => {
    const { exec, calls } = fakeExec();
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    const dirty = join(dir, 'web-everything__web-everything.dirty');
    writeFileSync(dirty, '');
    const t = new Date(clock + 1_000); utimesSync(dirty, t, t);
    clock += 2_000;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(calls).toHaveLength(1); // inside the floor → served
    clock += DIRTY_REFRESH_FLOOR_MS;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(calls).toHaveLength(2);
  });

  it('markPrSnapshotDirty writes the per-repo marker (and the all-repos one for a cwd write)', () => {
    readSharedOpenPrs(opts({ fields: 'number', exec: fakeExec().exec }));
    expect(markPrSnapshotDirty({ repo: REPO, env: { WE_PR_SNAPSHOT_DIR: dir } })).toBe(true);
    expect(existsSync(join(dir, 'web-everything__web-everything.dirty'))).toBe(true);
    expect(markPrSnapshotDirty({ repo: null, env: { WE_PR_SNAPSHOT_DIR: dir } })).toBe(true);
    expect(existsSync(join(dir, '_all.dirty'))).toBe(true);
    expect(markPrSnapshotDirty({ repo: REPO, env: { VITEST: '1' } })).toBe(false); // never the real dir from a test
  });

  it('is NOT applicable (null, no gh call) for a cwd repo, an unknown field, or when disabled', () => {
    const { exec, calls } = fakeExec();
    expect(readSharedOpenPrs(opts({ repo: null, fields: 'number', exec }))).toBe(null);
    expect(readSharedOpenPrs(opts({ fields: 'number,commits', exec }))).toBe(null);
    expect(readSharedOpenPrs({ repo: REPO, fields: 'number', exec, env: { VITEST: '1' } })).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('a failed refresh THROWS the gh error (the direct read would hit the same wall — never a double spend)', () => {
    const exec = () => { const e = new Error('GraphQL: API rate limit already exceeded for installation ID 1'); e.status = 1; throw e; };
    expect(() => readSharedOpenPrs(opts({ fields: 'number', exec }))).toThrow(/rate limit/);
  });
});

describe('per-head-SHA cache (the drain\'s commits read)', () => {
  it('round-trips a value keyed by (repo, PR, sha, kind) and ignores an unknown sha', () => {
    expect(writeShaCache({ repo: REPO, num: 7, sha: 'deadbeef1', kind: 'commits', value: [{ oid: 'x' }], dir })).toBe(true);
    expect(readShaCache({ repo: REPO, num: 7, sha: 'deadbeef1', kind: 'commits', dir })).toEqual([{ oid: 'x' }]);
    expect(readShaCache({ repo: REPO, num: 7, sha: 'deadbeef2', kind: 'commits', dir })).toBe(undefined);
    expect(writeShaCache({ repo: REPO, num: 7, sha: null, kind: 'commits', value: [], dir })).toBe(false);
  });
});

describe('the pass readers are wired to the snapshot (a seeded fresh snapshot is served; gh is never run)', () => {
  let saved;
  beforeEach(() => {
    saved = { PATH: process.env.PATH, WE_PR_SNAPSHOT_DIR: process.env.WE_PR_SNAPSHOT_DIR };
    // A `gh` that fails loudly — a reader that bypassed the snapshot would hit it and throw.
    const bin = mkdtempSync(join(tmpdir(), 'pr-snapshot-gh-'));
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "real gh must not run" >&2\nexit 97\n');
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    process.env.WE_PR_SNAPSHOT_DIR = dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath(dir, REPO), JSON.stringify({
      v: PR_SNAPSHOT_VERSION, repo: REPO, fetchedAtMs: Date.now(), fields: [...SNAPSHOT_FIELDS], limit: 25, count: 14, truncated: false, prs: PRS,
    }));
  });
  afterEach(() => {
    process.env.PATH = saved.PATH;
    if (saved.WE_PR_SNAPSHOT_DIR == null) delete process.env.WE_PR_SNAPSHOT_DIR; else process.env.WE_PR_SNAPSHOT_DIR = saved.WE_PR_SNAPSHOT_DIR;
  });

  it.each([
    // `readCommits` stubbed: its default (`fetchPrCommits`) runs a real `git fetch origin` per unlabelled PR.
    ['../../conveyor/reconcile-pass.mjs', 'defaultReadPrs', { readCommits: () => [] }],
    ['../../conveyor/advisory-label-sweep.mjs', 'defaultListPrs'],
    ['../../conveyor/ci-red-recovery-watch.mjs', 'defaultReadOpenPrs'],
    ['../../conveyor/parked-pr-conflict-watch.mjs', 'defaultListParkedPrs'],
    ['../../conveyor/stuck-pr-watch.mjs', 'defaultListOpenPrs'],
    ['../../conveyor/duplicate-pr-watch.mjs', 'defaultListOpenPrs'],
    ['../../conveyor/parked-pr-progress-watch.mjs', 'defaultListParkedPrs'],
  ])('%s#%s', async (mod, fn, extra = {}) => {
    const m = await import(mod);
    const got = m[fn]({ repo: REPO, ...extra });
    expect(got).toHaveLength(14);
    expect(got[0].number).toBe(100);
  }, 60_000); // the first dynamic import of a heavy conveyor module can exceed the 5s default on a loaded host

  it('pr-limit#fetchOpenPrs', async () => {
    const { fetchOpenPrs } = await import('../pr-limit.mjs');
    expect(fetchOpenPrs(REPO)).toHaveLength(14);
  });

  it('keeps a snapshot file written by the reader intact (sanity: the seeded file is what was served)', () => {
    expect(JSON.parse(readFileSync(snapshotPath(dir, REPO), 'utf8')).count).toBe(14);
  });
});


it('preserves a non-error admission deferral without caching an empty snapshot', () => {
  const deferred = { outcome: 'deferred-low-budget', deferred: true, priority: 'background' };
  expect(readSharedOpenPrs(opts({ fields: 'number', exec: () => JSON.stringify(deferred), allowDeferred: true }))).toEqual(deferred);
  expect(existsSync(snapshotPath(dir, REPO))).toBe(false);
});

it('returns null (the Array|null contract) on a deferral unless the caller opts in', () => {
  const deferred = { outcome: 'deferred-low-budget', deferred: true, priority: 'normal' };
  expect(readSharedOpenPrs(opts({ fields: 'number', exec: () => JSON.stringify(deferred) }))).toBe(null);
  expect(existsSync(snapshotPath(dir, REPO))).toBe(false);
});

it('marks the snapshot refresh deferrable only when the caller opted in', () => {
  const seen = [];
  const exec = (_b, _a, o) => { seen.push(o.throttle.deferrable); return '[]'; };
  readSharedOpenPrs(opts({ fields: 'number', exec, allowDeferred: true }));
  rmSync(snapshotPath(dir, REPO), { force: true });
  readSharedOpenPrs(opts({ fields: 'number', exec }));
  expect(seen).toEqual([true, false]);
});

it('cache-only planner reads never wait for or initiate a snapshot refresh', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-local-'));
  let calls = 0;
  const exec = () => { calls++; throw new Error('network forbidden'); };
  try {
    expect(readSharedOpenPrs({ repo: REPO, fields: 'number', dir, exec, cacheOnly: true })).toBeNull();
    expect(calls).toBe(0);
    writeFileSync(snapshotPath(dir, REPO), JSON.stringify({ v: PR_SNAPSHOT_VERSION, repo: REPO, fields: ['number'], fetchedAtMs: Date.now(), prs: [{ number: 42 }], count: 1 }));
    expect(readSharedOpenPrs({ repo: REPO, fields: 'number', dir, exec, cacheOnly: true })).toEqual([{ number: 42 }]);
    expect(calls).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
