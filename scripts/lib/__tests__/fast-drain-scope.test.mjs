import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_FIELDS } from '../pr-snapshot.mjs';
import { buildManifest, embedManifestInBody, extractManifestFromBody } from '../../readiness/lane-manifest.mjs';
import { fetchPrReadsCached, prReadCacheIdentity, reduceOpenPrContext, planDrainPass } from '../../merge-ai-prs.mjs';
import {
  shaCacheRepo, resolveFastDrainScopeSetting, resolveFastDrainListingSetting, mergeLiveTargetIntoRows, shouldReadContextCommits,
  filterToFastDrainTarget, readLegacyManifestCached, readLegacyLocalManifestAt,
} from '../fast-drain-scope.mjs';

describe('fast drain scope', () => {
  it('normalizes the local cache repo without changing an explicit repo', () => {
    expect(shaCacheRepo(null, 'web-everything/web-everything')).toBe('web-everything/web-everything');
    expect(shaCacheRepo('other/repo', 'web-everything/web-everything')).toBe('other/repo');
  });

  const resolve = (options = {}) => resolveFastDrainScopeSetting({ env: {}, tool: {}, platform: {}, ...options });
  it('defaults to target from the standard', () => {
    expect(resolve()).toEqual({ scope: 'target', source: 'standard', line: 'fast-drain: mergeQueue.fastDrain.scope=target (standard)' });
  });
  it('resolves platform, tool and env in cascade order', () => {
    expect(resolve({ platform: { scope: 'full' } })).toMatchObject({ scope: 'full', source: 'platform' });
    expect(resolve({ tool: { scope: 'full' } })).toMatchObject({ scope: 'full', source: 'tool' });
    expect(resolve({ tool: { scope: 'target' }, env: { WE_FAST_DRAIN_SCOPE: 'full' } })).toMatchObject({ scope: 'full', source: 'env' });
  });
  it('rejects and reports invalid settings', () => {
    for (const options of [{ tool: { scope: 'bogus' } }, { env: { WE_FAST_DRAIN_SCOPE: 'bogus' } }]) {
      expect(resolve(options)).toMatchObject({ scope: 'target', source: 'standard' });
      expect(resolve(options).line).toMatch(/ignored invalid:.*bogus/);
    }
  });

  it.each([
    [null, 'target', false, true], [null, 'target', true, true],
    [7, 'target', false, false], [7, 'target', true, true],
    [7, 'full', false, true], [7, 'full', true, true],
  ])('selects commits for onlyPr=%s scope=%s target=%s', (onlyPr, scope, isTarget, expected) => {
    expect(shouldReadContextCommits({ onlyPr, scope, isTarget })).toBe(expected);
  });
  it('filters housekeeping only for a target-scoped fast drain', () => {
    const prs = [{ number: 7 }, { number: 8 }];
    const isTarget = (p) => p.number === 7;
    expect(filterToFastDrainTarget(prs, { onlyPr: 7, scope: 'target', isTarget })).toEqual([prs[0]]);
    expect(filterToFastDrainTarget(prs, { onlyPr: null, scope: 'target', isTarget })).toBe(prs);
    expect(filterToFastDrainTarget(prs, { onlyPr: 7, scope: 'full', isTarget })).toBe(prs);
  });
});

describe('legacy manifest persistence', () => {
  const key = { repo: 'web-everything/web-everything', num: 7, sha: 'abc', kind: 'legacy-manifest-v2' };
  it.each([null, { item: 7 }])('reuses a cached answer %s without a git read', async (manifest) => {
    const readCache = vi.fn(() => manifest), writeCache = vi.fn(), readLegacy = vi.fn();
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toEqual({ manifest, definitive: true, unreadable: false });
    expect(readCache).toHaveBeenCalledWith(key);
    expect(readLegacy).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });
  it.each([
    [{ item: 7 }, true, true], [{ item: 7 }, false, false],
    [null, true, true], [null, false, false],
  ])('caches manifest=%s definitive=%s only when read from the head sha', async (manifest, definitive, persists) => {
    const readCache = vi.fn(() => undefined), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest, definitive }));
    // `definitive` rides back so the in-memory per-pass caches can skip a non-head answer too.
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toEqual({ manifest, definitive, unreadable: false });
    if (persists) expect(writeCache).toHaveBeenCalledWith({ ...key, value: manifest });
    else expect(writeCache).not.toHaveBeenCalled();
  });
  it('never reads or writes the cache without a head sha', async () => {
    const readCache = vi.fn(() => ({ item: 9 })), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest: { item: 7 }, definitive: true }));
    expect(await readLegacyManifestCached({ ...key, sha: null, readCache, writeCache, readLegacy })).toEqual({ manifest: { item: 7 }, definitive: false, unreadable: false });
    expect(readCache).not.toHaveBeenCalled();
    expect(writeCache).not.toHaveBeenCalled();
  });
  it('passes an unreadable head through uncached so the caller fails closed', async () => {
    const readCache = vi.fn(() => undefined), writeCache = vi.fn();
    const readLegacy = vi.fn(async () => ({ manifest: null, definitive: false, unreadable: true }));
    expect(await readLegacyManifestCached({ ...key, readCache, writeCache, readLegacy })).toEqual({ manifest: null, definitive: false, unreadable: true });
    expect(writeCache).not.toHaveBeenCalled();
  });
});

describe('legacy manifest revision identity', () => {
  const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40), STALE = 'c'.repeat(40);
  /** A fake clone: `commits` maps a sha to its manifest (or undefined = no manifest file); `refs` maps a ref to a sha. */
  const fakeGit = ({ commits = {}, refs = {}, fetch = () => {}, fail = {} }) => {
    const calls = [];
    const resolveRev = (rev) => (rev in commits ? rev : refs[rev]);
    const git = (args) => {
      calls.push(args);
      if (fail[args[0]]) throw new Error(`transient ${args[0]} failure`);
      if (args[0] === 'fetch') return fetch(args);
      const target = args[args.length - 1];
      if (args[0] === 'cat-file') {
        const sha = target.replace(/\^\{commit\}$/, '');
        if (sha in commits) return '';
        throw new Error('missing object');
      }
      if (args[0] === 'ls-tree') {
        const sha = args[args.indexOf('--end-of-options') + 1];
        if (!(sha in commits)) throw new Error('not a tree object');
        return commits[sha] === undefined ? '' : `100644 blob ${'f'.repeat(40)}\t${target}\n`;
      }
      if (args[0] === 'show') {
        const [rev, path] = target.split(':');
        const m = commits[resolveRev(rev)];
        if (path !== '.lane-manifest.json' || m === undefined) throw new Error('no such path');
        return JSON.stringify(m);
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    };
    return { git, calls };
  };
  const failFetch = () => { throw new Error('network'); };

  // With a full head sha, a fallback ref can only name ANOTHER commit, so its manifest is neither used nor cached;
  // the unreadable head fails closed (`unreadable` → degraded) rather than reading as "not a carrier".
  const UNREADABLE = { manifest: null, definitive: false, unreadable: true };
  it('does not use or cache a stale origin ref after a failed fetch', () => {
    const { git } = fakeGit({ commits: { [STALE]: { item: 3 } }, refs: { 'origin/lane/x': STALE }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual(UNREADABLE);
  });
  it('does not use or cache a manifest from stale FETCH_HEAD after fetch failure', () => {
    const { git } = fakeGit({ commits: { [OTHER]: { item: 99 } }, refs: { FETCH_HEAD: OTHER }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual(UNREADABLE);
  });
  it('does not use FETCH_HEAD when another drain process moved it and the head object is still missing', () => {
    const { git } = fakeGit({ commits: { [OTHER]: { item: 99 } }, refs: { FETCH_HEAD: OTHER } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual(UNREADABLE);
  });
  it('reads the head sha, not FETCH_HEAD, when a concurrent drain moved FETCH_HEAD to another PR', () => {
    const { git } = fakeGit({ commits: { [HEAD]: { item: 7 }, [OTHER]: { item: 99 } }, refs: { FETCH_HEAD: OTHER } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual({ manifest: { item: 7 }, definitive: true, unreadable: false });
  });
  it('does not use or cache a fork branch named main as the PR head', () => {
    const { git } = fakeGit({ commits: { [OTHER]: { item: 1 } }, refs: { main: OTHER, 'origin/main': OTHER }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'main', headSha: HEAD, prNumber: 7, git })).toEqual(UNREADABLE);
  });
  it('fetches a fork head through refs/pull/<n>/head, never needing a same-named origin branch', () => {
    const commits = { [OTHER]: { item: 1 } };
    const { git, calls } = fakeGit({ commits, refs: { 'origin/main': OTHER }, fetch: (args) => {
      if (args.at(-1) === 'refs/pull/7/head') commits[HEAD] = { item: 7 }; else throw new Error('no such ref');
    } });
    expect(readLegacyLocalManifestAt({ headRef: 'main', headSha: HEAD, prNumber: 7, git })).toEqual({ manifest: { item: 7 }, definitive: true, unreadable: false });
    expect(calls.filter(a => a[0] === 'fetch').map(a => a.at(-1))).toEqual(['refs/pull/7/head']);
  });
  it.each([undefined, 0, -1, 1.5, '7', NaN])('never builds a pull ref from an invalid PR number %s', (prNumber) => {
    const { git, calls } = fakeGit({ fetch: failFetch });
    readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber, git });
    expect(calls.filter(a => a[0] === 'fetch').map(a => a.at(-1))).toEqual(['lane/x']);
  });
  it.each(['ls-tree', 'show'])('does not turn a failed %s of the head into a definitive absence', (op) => {
    const { git } = fakeGit({ commits: { [HEAD]: { item: 7 } }, fail: { [op]: true } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual(UNREADABLE);
  });
  it('answers definitively from a local head object even when the fetch fails, without fetching', () => {
    const { git, calls } = fakeGit({ commits: { [HEAD]: undefined, [STALE]: { item: 3 } }, refs: { 'origin/lane/x': STALE }, fetch: failFetch });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual({ manifest: null, definitive: true, unreadable: false });
    expect(calls.some(a => a[0] === 'fetch')).toBe(false);
  });
  it('fetches a missing head object, then reads it definitively', () => {
    const commits = {};
    const { git } = fakeGit({ commits, fetch: () => { commits[HEAD] = { item: 7 }; } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha: HEAD, prNumber: 7, git })).toEqual({ manifest: { item: 7 }, definitive: true, unreadable: false });
  });
  it.each([null, '', 'HEAD', `--output=/tmp/x`, 'A'.repeat(40), 'a'.repeat(39)])('fails closed on an invalid head sha %s without using FETCH_HEAD', (headSha) => {
    const { git, calls } = fakeGit({ commits: { [OTHER]: { item: 1 } }, refs: { FETCH_HEAD: OTHER } });
    expect(readLegacyLocalManifestAt({ headRef: 'lane/x', headSha, prNumber: 7, git })).toEqual(UNREADABLE);
    expect(calls).toEqual([]);
  });
  it('keeps a dash-leading head ref behind --end-of-options', () => {
    const { git, calls } = fakeGit({ fetch: failFetch });
    readLegacyLocalManifestAt({ headRef: '--upload-pack=x', headSha: HEAD, git });
    for (const args of calls) {
      const at = args.findIndex(a => a.includes('--upload-pack'));
      if (at >= 0) expect(args.indexOf('--end-of-options')).toBeGreaterThanOrEqual(0);
      if (at >= 0) expect(args.indexOf('--end-of-options')).toBeLessThan(at);
    }
  });
});


describe('fast drain listing', () => {
  const resolve = (options = {}) => resolveFastDrainListingSetting({ env: {}, tool: {}, platform: {}, ...options });
  it('defaults to snapshot from the standard', () => {
    expect(resolve()).toEqual({ listing: 'snapshot', source: 'standard', line: 'fast-drain: mergeQueue.fastDrain.listing=snapshot (standard)' });
  });
  it('resolves platform, tool and env in cascade order', () => {
    expect(resolve({ platform: { listing: 'live' } })).toMatchObject({ listing: 'live', source: 'platform' });
    expect(resolve({ platform: { listing: 'snapshot' }, tool: { listing: 'live' } })).toMatchObject({ listing: 'live', source: 'tool' });
    expect(resolve({ tool: { listing: 'snapshot' }, env: { WE_FAST_DRAIN_LISTING: 'live' } })).toMatchObject({ listing: 'live', source: 'env' });
  });
  it('reads the declared tool fastDrain block', () => {
    expect(resolve({ tool: undefined, readSettings: () => ({ settings: { mergeQueue: { fastDrain: { listing: 'live' } } } }) })).toMatchObject({ listing: 'live', source: 'tool' });
  });
  it.each([
    { platform: { listing: 'bogus' } }, { tool: { listing: 'bogus' } },
    { env: { WE_FAST_DRAIN_LISTING: 'bogus' } },
  ])('ignores and reports invalid listing settings: %s', (options) => {
    expect(resolve(options)).toMatchObject({ listing: 'snapshot', source: 'standard' });
    expect(resolve(options).line).toMatch(/ignored invalid:.*bogus/);
  });
});

describe('mergeLiveTargetIntoRows', () => {
  const other = Object.freeze({ number: 8 });
  const stale = Object.freeze({ number: 7, title: 'stale' });
  const rows = Object.freeze([stale, other]);
  it('replaces the target using string-normalized numbers without mutation', () => {
    const target = Object.freeze({ number: 7, state: 'OPEN', title: 'live' });
    const result = mergeLiveTargetIntoRows(rows, target, '7');
    expect(result).toEqual([target, other]);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(target);
    expect(rows).toEqual([stale, other]);
  });
  it('appends a missing target, including a row without state', () => {
    const target = Object.freeze({ number: 9 });
    expect(mergeLiveTargetIntoRows(rows, target, 9)).toEqual([stale, other, target]);
  });
  it.each([null, { number: 7, state: 'CLOSED' }, { number: 7, state: 'MERGED' }])('removes a null or closed target: %s', (target) => {
    expect(mergeLiveTargetIntoRows(rows, target, '7')).toEqual([other]);
    expect(rows).toEqual([stale, other]);
  });
});

describe('snapshot fast drain CLI dependency context', () => {
  const repo = 'fixture/repo';
  const pr = (number, item, blockedBy = []) => ({
    number, title: `fixture ${number}`, state: 'OPEN', headRefName: `lane/${item}`, headRefOid: `sha${number}`,
    updatedAt: '2026-10-14T00:00:00Z', baseRefName: 'main', isDraft: false,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
    labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], files: [],
    statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    body: embedManifestInBody('fixture', buildManifest({ item, blockedBy,
      repos: [{ repo: 'we', ref: `lane/${item}` }] })),
  });

  // Exercise the actual listOne -> context -> planner wiring, with a still-servable snapshot that predates A.
  // No git repository or network is needed: fake git supplies only the local repo identity.
  const run = ({ snapshot, live, target = live.find(p => p.number === 7), failPage = false, extraLive = {} }) => {
    const dir = mkdtempSync(join(tmpdir(), 'fast-drain-context-'));
    try {
      const bin = join(dir, 'bin');
      const snapshots = join(dir, 'snapshots');
      mkdirSync(bin);
      mkdirSync(snapshots);
      mkdirSync(join(dir, 'backlog'));
      writeFileSync(join(snapshots, 'fixture__repo.json'), JSON.stringify({ v: 1, repo,
        fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS, count: snapshot.length, prs: snapshot }));
      for (const name of ['frontierui', 'plateau-app']) {
        writeFileSync(join(snapshots, `fixture__${name}.json`), JSON.stringify({ v: 1, repo: `fixture/${name}`,
          fetchedAtMs: Date.now(), fields: SNAPSHOT_FIELDS, count: 0, prs: [] }));
      }
      writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ live, target, failPage, extraLive }));
      writeFileSync(join(dir, 'calls.jsonl'), '');
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1 $2" = "remote get-url" ]; then echo https://github.com/fixture/repo.git; exit 0; fi\nexit 1\n', { mode: 0o755 });
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const f = JSON.parse(fs.readFileSync(process.env.CONTEXT_FIXTURE, 'utf8'));
fs.appendFileSync(process.env.CONTEXT_LOG, JSON.stringify(a) + '\\n');
const output = value => { fs.writeSync(1, JSON.stringify(value)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') { fs.writeSync(1, 'main'); process.exit(0); }
if (a[0] === 'api' && a[1] === 'graphql' && a.some(v => v.includes('pullRequests(states:OPEN'))) {
  if (f.failPage === true || f.failPage === process.env.GH_REPO) { fs.writeSync(2, 'fixture listing unreadable'); process.exit(1); }
  const rows = process.env.GH_REPO === 'fixture/repo' ? f.live : (f.extraLive[process.env.GH_REPO] || []);
  output({data:{repository:{pullRequests:{totalCount:rows.length,
    pageInfo:{hasNextPage:false,endCursor:null},nodes:rows.map(p => ({...p, labels:{nodes:p.labels},
      commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:p.statusCheckRollup.map(c => ({...c,__typename:'CheckRun'}))}}}}]}}))}}}});
}
if (a[0] === 'pr' && a[1] === 'list') output([]);
if (a[0] === 'pr' && a[1] === 'view') {
  const fields = (a[a.indexOf('--json') + 1] || '').split(',');
  if (fields.includes('state')) output(f.target);
  if (fields.includes('commits')) output({commits:[]});
  const repoIdx = a.indexOf('--repo');
  const rows = repoIdx < 0 || a[repoIdx + 1] === 'fixture/repo' ? f.live : (f.extraLive[a[repoIdx + 1]] || []);
  output(rows.find(p => p.number === Number(a[2])) || {});
}
output({});
`, { mode: 0o755 });
      const script = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs');
      const result = spawnSync(process.execPath, [script,
        `--repos=${repo}`, '--only=7', `--only-repo=${repo}`, '--label=ready-to-merge', '--dry-run', '--json',
        '--no-drain-lease', '--no-red-main-freeze', '--no-review-escalation', '--repoll-delay=0'], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WE_FAST_DRAIN_LISTING: 'snapshot',
          HOME: dir, WE_UNDER_TEST: '1', WE_GITHUB_AUTH: 'personal',
          WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_DIR: snapshots, WE_PR_SNAPSHOT_TTL_MS: '600000',
          WE_GH_THROTTLE_GH_BIN: join(bin, 'gh'), WE_GH_THROTTLE_LOCK_ROOT: join(dir, 'throttle'),
          WE_GH_THROTTLE_COST_HEADERS: '0', WE_GH_THROTTLE_RETRY_MAX_ATTEMPTS: '1',
          CONTEXT_FIXTURE: join(dir, 'fixture.json'), CONTEXT_LOG: join(dir, 'calls.jsonl') },
      });
      const calls = readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
      return { ...result, payload: JSON.parse(result.stdout.trim() || '{}'), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('defers B on an unlabelled, cross-base blocker opened after the snapshot', () => {
    const staleB = pr(7, 'xbbbbbb');
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const a = { ...pr(8, 'xaaaaaa'), labels: [], baseRefName: 'develop' };
    const r = run({ snapshot: [staleB], live: [a, b] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.considered).toBe(1);
    expect(r.payload.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: 7, waitOn: expect.arrayContaining(['xaaaaaa']) }),
    ]));
  }, 30_000);

  it('fails the pass when live context cannot be read, even with a usable snapshot and target', () => {
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const r = run({ snapshot: [b], live: [b], failPage: true });
    expect(r.status, r.stderr).toBe(4);
    expect(r.payload).toMatchObject({ ok: false, reason: 'gh-error' });
  }, 30_000);

  it('keeps a dependency added to B between the target read and the live pages', () => {
    const earlierB = pr(7, 'xbbbbbb');
    const b = { ...pr(7, 'xbbbbbb', ['xaaaaaa']), updatedAt: '2026-10-14T00:01:00Z' };
    const a = { ...pr(8, 'xaaaaaa'), labels: [] };
    const r = run({ snapshot: [earlierB], live: [a, b], target: earlierB });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: 7, waitOn: expect.arrayContaining(['xaaaaaa']) }),
    ]));
  }, 30_000);

  it('invalidates watch manifest reads after a body edit at an unchanged head SHA', async () => {
    const cache = new Map();
    const a = pr(8, 'xaaaaaa');
    const b = pr(7, 'xbbbbbb');
    const fetchOne = vi.fn(async p => ({ manifest: extractManifestFromBody(p.body) }));
    const read = rows => fetchPrReadsCached(rows, { cache, keyOf: p => `${repo}::${p.number}`,
      shaOf: prReadCacheIdentity, fetchOne });
    await read([a, b]);
    const changedB = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const rows = [a, changedB];
    const reads = await read(rows);
    const context = reduceOpenPrContext({ listings: [{ repo, prs: rows }],
      reads: new Map([...reads].map(([key, entry]) => [key, entry.value])) });
    const { plan } = planDrainPass({ openPrContext: context, verdicts: [{ num: 7, repo, item: 'xbbbbbb',
      hasManifest: true, decision: 'merge', blockedBy: reads.get(`${repo}::7`).value.manifest.blockedBy }] });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred[0].waitOn).toContain('xaaaaaa');
    expect(fetchOne).toHaveBeenCalledTimes(3); // A remains cached; B's changed body is read again.
  });

  it('also discovers a new blocker in a context-only repository', () => {
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const a = { ...pr(8, 'xaaaaaa'), labels: [] };
    const r = run({ snapshot: [b], live: [b], extraLive: { 'fixture/frontierui': [a] } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: 7, waitOn: expect.arrayContaining(['xaaaaaa']) }),
    ]));
  }, 30_000);

  it('defers B when a context-only repository is unreadable', () => {
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const r = run({ snapshot: [b], live: [b], failPage: 'fixture/frontierui',
      extraLive: { 'fixture/frontierui': [pr(8, 'xaaaaaa')] } });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: 7, waitOn: expect.arrayContaining(['xaaaaaa']) }),
    ]));
  }, 30_000);

  // Production proof sets: `provenOnMain` holds hash ids only (`isHash(id) && landedNumberFor(...)`), never numerics.
  const incomplete = { contextComplete: false, truncated: true, openItems: new Set() };
  const absentDep = (edge, item) => ({ num: 7, repo, item: 'xbbbbbb', hasManifest: true, decision: 'merge', [edge]: [item] });

  it.each([
    [false, 'blockedBy'], [false, 'stackParents'], [true, 'blockedBy'], [true, 'stackParents'],
  ])('fast drain %s: an absent numeric %s clears on incomplete context with no numeric proof', (fastDrain, edge) => {
    const { plan } = planDrainPass({ openPrContext: incomplete, verdicts: [absentDep(edge, 123)],
      provenOnMain: new Set(), strictAbsentHashDependencies: fastDrain });
    expect(plan.deferred).toEqual([]);
    expect(plan.ready).toHaveLength(1);
  });

  it('full pass: an absent hash blockedBy keeps its pre-existing clear on incomplete context', () => {
    const { plan } = planDrainPass({ openPrContext: incomplete, verdicts: [absentDep('blockedBy', 'xaaaaaa')] });
    expect(plan.ready).toHaveLength(1);
  });

  it.each(['blockedBy', 'stackParents'])('fast drain: an absent hash %s needs positive proof on incomplete context', (edge) => {
    const opts = { openPrContext: incomplete, verdicts: [absentDep(edge, 'xaaaaaa')], strictAbsentHashDependencies: true };
    const { plan } = planDrainPass(opts);
    expect(plan.ready).toEqual([]);
    expect(plan.deferred[0].waitOn).toContain('xaaaaaa');
    const proven = planDrainPass({ ...opts, provenOnMain: new Set(['xaaaaaa']) });
    expect(proven.plan.ready).toHaveLength(1);
  });

  it('hydrates a sibling whose manifest changed at the same head SHA', () => {
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const staleA = { ...pr(8, 'xcccccc'), labels: [] };
    const a = { ...pr(8, 'xaaaaaa'), labels: [], updatedAt: '2026-10-14T00:01:00Z' };
    const r = run({ snapshot: [b, staleA], live: [b, a] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.deferred).toEqual(expect.arrayContaining([
      expect.objectContaining({ num: 7, waitOn: expect.arrayContaining(['xaaaaaa']) }),
    ]));
    expect(r.calls.some(a => a[0] === 'pr' && a[1] === 'view' && a[2] === '8')).toBe(true);
  }, 30_000);

  it('drops a closed sibling and reuses unchanged heavy fields without another target hydration', () => {
    const b = pr(7, 'xbbbbbb', ['xaaaaaa']);
    const r = run({ snapshot: [b, pr(8, 'xaaaaaa')], live: [b] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.payload.deferred).toEqual([]);
    expect(r.payload.toMerge).toEqual(expect.arrayContaining([expect.objectContaining({ num: 7 })]));
    const heavyReads = r.calls.filter(a => a[0] === 'pr' && a[1] === 'view'
      && a[a.indexOf('--json') + 1] === 'body,files');
    expect(heavyReads).toEqual([]);
  }, 30_000);
});
