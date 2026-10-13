/**
 * @file scripts/lib/__tests__/pr-snapshot.test.mjs
 * @description #gh-graphql-budget — the host-shared open-PR snapshot. Live 2026-09-27: ~10 daemons each ran their
 *   own `gh pr list --limit 200 --json …` for the same 3 repos every 1-2 min and exhausted the App installation's
 *   6100-points/hour GraphQL budget every hour. Proves: many readers with different field sets inside the TTL
 *   share ONE paged refresh with cached heavy hydration; a write (dirty marker) forces a refresh after the floor; full pages advance cursors; a failed fetch throws (never a silent double spend); tests/cwd repos are never served from disk; and
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
import { PrListUnreadableError } from '../pr-list-paged.mjs';
import { ghThrottleLogPath } from '../gh-throttle.mjs';
import { prSnapshotEnabled, markPrSnapshotDirty, repoFromGhArgs, snapshotPath, PR_SNAPSHOT_VERSION } from '../pr-snapshot-store.mjs';

const REPO = 'web-everything/web-everything';
const PRS = Array.from({ length: 14 }, (_, i) => ({
  number: 100 + i, title: `t${i}`, body: `b${i}`, url: `u${i}`, isDraft: false, createdAt: 'c', updatedAt: 'u',
  headRefName: `lane/x${i}`, headRefOid: `abc${i}`, baseRefName: 'main', isCrossRepository: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  labels: [{ name: 'ready-to-merge' }], files: [{ path: 'a.mjs' }], comments: [{ body: 'hi' }], statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED',
    startedAt: 's', completedAt: 'e', detailsUrl: 'url', workflowName: 'build' }],
}));

const PAGING = { pageSize: 20, pageRetries: 1, heavyMaxAgeSeconds: 600, source: { pageSize: 'standard' } };
const pageCalls = calls => calls.filter(a => a[0] === 'api');
const viewCalls = calls => calls.filter(a => a[0] === 'pr');

function fakeExec(prs = PRS) {
  const calls = [];
  const exec = (file, argv) => {
    expect(file).toBe('gh');
    calls.push(argv);
    if (argv[0] === 'api') {
      expect(argv.slice(0, 3)).toEqual(['api', 'graphql', '-f']);
      const query = argv[3];
      const size = Number(query.match(/first:(\d+)/)[1]);
      const start = Number(query.match(/after:"(\d+)"/)?.[1] ?? 0);
      const end = Math.min(start + size, prs.length);
      const nodes = prs.slice(start, end).map(({ comments, body, files, labels, statusCheckRollup, ...p }) => ({
        ...p, labels: { nodes: labels }, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: {
          nodes: statusCheckRollup.map(({ workflowName, ...c }) => c.__typename === 'CheckRun'
            ? { ...c, checkSuite: { workflowRun: { workflow: { name: workflowName } } } }
            : { ...c, createdAt: c.startedAt }),
        } } } }] },
      }));
      return JSON.stringify({ data: { repository: { pullRequests: { nodes, totalCount: prs.length,
        pageInfo: { hasNextPage: end < prs.length, endCursor: String(end) } } } } });
    }
    expect(argv).toEqual(['pr', 'view', argv[2], '--repo', REPO, '--json', 'comments,body,files']);
    const { comments, body, files } = prs.find(p => p.number === Number(argv[2]));
    return JSON.stringify({ comments, body, files });
  };
  return { exec, calls };
}

let dir;
let clock;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pr-snapshot-')); clock = Date.parse('2026-09-27T06:00:00Z'); });
const opts = (extra = {}) => ({ repo: REPO, dir, now: () => clock, env: { VITEST: '1' }, paging: PAGING, ...extra });

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
  it('preserves capped comments unchanged through fresh and cached projections (#5955)', () => {
    const comments = Array.from({ length: 100 }, (_, i) => ({ body: `comment ${i}`, author: { login: 'someone' } }));
    const { exec, calls } = fakeExec([{ ...PRS[0], comments }]);
    const fields = 'number,labels,headRefOid,comments';
    const first = readSharedOpenPrs(opts({ fields, exec }));
    expect(first).toEqual([{ number: PRS[0].number, labels: PRS[0].labels, headRefOid: PRS[0].headRefOid, comments }]);
    expect(readSharedOpenPrs(opts({ fields, exec }))).toEqual(first);
    expect(pageCalls(calls)).toHaveLength(1);
    expect(viewCalls(calls)).toHaveLength(1);
    expect(SNAPSHOT_FIELDS).toContain('comments');
  });
  it('8 readers with 8 different field sets inside the TTL share ONE paged refresh and hydration', () => {
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
      expect(got).toEqual(projectPrs(PRS, fields.split(',')));
      clock += 5_000;
    }
    expect(pageCalls(calls)).toHaveLength(1);
    expect(viewCalls(calls)).toHaveLength(PRS.length);
    expect(pageCalls(calls)[0][3]).toContain('first:20');
    for (const argv of pageCalls(calls)) expect(argv[3]).not.toMatch(/comments|body|files\(/);
  });

  it('refreshes after the TTL and reuses unchanged heavy fields', () => {
    const { exec, calls } = fakeExec();
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    calls.length = 0;
    clock += 80_000;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(pageCalls(calls)).toHaveLength(1);
    expect(viewCalls(calls)).toHaveLength(0);
    const snap = JSON.parse(readFileSync(snapshotPath(dir, REPO), 'utf8'));
    expect(snap.paging).toMatchObject({ hydrated: 0, reused: 14 });
    expect(Object.keys(snap.heavyMeta[100]).sort()).toEqual(['fetchedAtMs', 'headRefOid', 'updatedAt']);
    expect(snapshotOpenCount(REPO, { dir })).toBe(14);
  });

  it('60 PRs at pageSize 20 use three GraphQL pages', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...PRS[0], number: i }));
    const { exec, calls } = fakeExec(many);
    const got = readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(got).toHaveLength(60);
    expect(pageCalls(calls)).toHaveLength(3);
    expect(pageCalls(calls).map(a => a[3].match(/after:"(\d+)"/)?.[1] ?? null)).toEqual([null, '20', '40']);
    for (const argv of pageCalls(calls)) expect(argv[3]).not.toMatch(/comments|body|files\(/);
  });

  it('a write (dirty marker) forces a refresh once past the floor, not before', () => {
    const { exec, calls } = fakeExec();
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    const dirty = join(dir, 'web-everything__web-everything.dirty');
    writeFileSync(dirty, '');
    const t = new Date(clock + 1_000); utimesSync(dirty, t, t);
    clock += 2_000;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(pageCalls(calls)).toHaveLength(1); // inside the floor → served
    clock += DIRTY_REFRESH_FLOOR_MS;
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(pageCalls(calls)).toHaveLength(2);
  });

  it('hydrates exactly one PR when its updatedAt changes', () => {
    const prs = structuredClone(PRS);
    const { exec, calls } = fakeExec(prs);
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    calls.length = 0;
    clock += 80_000;
    prs[3].updatedAt = 'changed';
    readSharedOpenPrs(opts({ fields: 'number', exec }));
    expect(viewCalls(calls)).toHaveLength(1);
    expect(viewCalls(calls)[0][2]).toBe(String(prs[3].number));
  });

  it('projects number,comments,body,files exactly from fresh and cached rows', () => {
    const { exec } = fakeExec();
    const expected = PRS.map(({ number, comments, body, files }) => ({ number, comments, body, files }));
    expect(readSharedOpenPrs(opts({ fields: 'number,comments,body,files', exec }))).toEqual(expected);
    expect(readSharedOpenPrs(opts({ fields: 'number,comments,body,files', exec }))).toEqual(expected);
    expect(readSharedOpenPrs(opts({ fields: 'reviewDecision', exec }))).toEqual(PRS.map(p => ({ reviewDecision: p.reviewDecision })));
  });

  it.each([false, true])('failed pages never publish or update a snapshot (previous=%s)', previous => {
    const many = Array.from({ length: 21 }, (_, i) => ({ ...PRS[0], number: i }));
    const fake = fakeExec(many);
    const path = snapshotPath(dir, REPO);
    if (previous) readSharedOpenPrs(opts({ fields: 'number', exec: fake.exec }));
    const before = previous ? readFileSync(path, 'utf8') : null;
    clock += 80_000;
    let failures = 0;
    const cause = Object.assign(new Error('gh failed'), {
      stderr: 'HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)',
    });
    const exec = (file, argv) => {
      if (argv[3]?.includes('after:')) { failures++; throw cause; }
      return fake.exec(file, argv);
    };
    let error;
    try { readSharedOpenPrs(opts({ fields: 'number', exec })); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(PrListUnreadableError);
    expect(error).toMatchObject({ code: 'pr-list-unreadable', stage: 'page', page: 2, cause });
    expect(failures).toBe(2);
    if (previous) expect(readFileSync(path, 'utf8')).toBe(before);
    else expect(existsSync(path)).toBe(false);
  });

  it('logs one paged refresh with setting source and payload evidence in an isolated log', () => {
    const lockRoot = join(dir, 'throttle');
    mkdirSync(lockRoot, { recursive: true });
    const { exec } = fakeExec();
    const o = opts({ fields: 'number', exec, caller: 'snapshot-test',
      env: { VITEST: '1', WE_GH_THROTTLE_LOCK_ROOT: lockRoot } });
    readSharedOpenPrs(o);
    readSharedOpenPrs(o);
    const entries = readFileSync(ghThrottleLogPath(lockRoot), 'utf8').trim().split('\n').map(JSON.parse);
    expect(entries.filter(e => e.outcome === 'paged')).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'pr list (snapshot)', outcome: 'paged', repo: REPO,
      caller: 'snapshot-test', pages: 1, pageSize: 20, pageSizeSource: 'standard', hydrated: 14, reused: 0, count: 14 });
    expect(entries[0].bytes).toBeGreaterThan(0);
    expect(entries[0].ms).toBeGreaterThanOrEqual(0);
    expect(entries[1].outcome).toBe('snapshot_hit');
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

  it('a failed refresh THROWS PrListUnreadableError (the direct read would hit the same wall — never a double spend)', () => {
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
  const empty = fakeExec([]).exec;
  const exec = (b, a, o) => { seen.push(o.throttle.deferrable); return empty(b, a); };
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
