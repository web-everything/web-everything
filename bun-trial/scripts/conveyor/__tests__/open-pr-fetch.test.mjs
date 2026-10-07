import { describe, it, test, expect, mock } from 'bun:test';
const __ORIG_URL = new URL('../../../../scripts/conveyor/__tests__/open-pr-fetch.test.mjs', import.meta.url).href;
const __ORIG_FILE = new URL(__ORIG_URL).pathname;
const __ORIG_DIR = new URL('.', __ORIG_URL).pathname.replace(/\/$/, '');
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultFetchOpenPrs, readPrsFromFile, OPEN_PR_LIST_FIELDS, PR_LIST_LIMIT,
  fetchOpenPrsRest, restPullToBuildDispatchShape, BUILD_DISPATCH_PR_FIELDS,
} from '../../../../scripts/conveyor/open-pr-fetch.mjs';
import { runGhSync } from '../../../../scripts/lib/gh-throttle.mjs';
import { normalizeOpenPrs } from '../../../../scripts/conveyor/build-dispatch-policy.mjs';
import { defaultListOpenPrs } from '../../../../scripts/conveyor/duplicate-pr-watch.mjs';
import { defaultListParkedPrs as listConflicts } from '../../../../scripts/conveyor/parked-pr-conflict-watch.mjs';
import { defaultListParkedPrs as listProgress } from '../../../../scripts/conveyor/parked-pr-progress-watch.mjs';
import { defaultReadPrs } from '../../../../scripts/conveyor/reconcile-pass.mjs';

// `execFileSyncThrottled`/`runGhSync` are mocked (existing tests drive `runGhSync` directly); every OTHER
// export (`ghAuthIdentity`, `deriveGhCaller`, `ghThrottleLockRoot`, …) stays REAL via `importOriginal` — the
// REST-path tests below pass their own `exec`, but still call through `gh-rest-read.mjs#ghRestGetJson`, which
// needs those real, pure helpers to resolve an identity/cache key. The end-to-end "real throttle" proof (no
// mocking at all) lives in its own file, `open-pr-fetch-rest-live.test.mjs`.
const __actual0 = { ...(await import('../../../../scripts/lib/gh-throttle.mjs')) };
mock.module('../../../../scripts/lib/gh-throttle.mjs', () => ({ ...__actual0, runGhSync: mock(), execFileSyncThrottled: mock() }));

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(__ORIG_URL)), 'fixtures', 'open-prs-rest-vs-graphql.json'), 'utf8',
));

function guardPrReads(row, reads = new Set()) {
  return new Proxy(row, {
    get(target, key, receiver) {
      reads.add(key);
      expect(BUILD_DISPATCH_PR_FIELDS, `PR field ${String(key)} is outside the supplied contract`).toContain(key);
      expect(Object.hasOwn(target, key), `PR field ${String(key)} is missing from the supplied row`).toBe(true);
      return Reflect.get(target, key, receiver);
    },
  });
}

describe('shared open-PR discovery', () => {
  it('pins the deduplicated union and proves every standalone field is included', () => {
    expect(PR_LIST_LIMIT).toBe(200);
    expect(OPEN_PR_LIST_FIELDS).toBe('number,headRefName,title,body,labels,files,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,comments,isDraft,createdAt');
    const union = OPEN_PR_LIST_FIELDS.split(',');
    expect(new Set(union).size).toBe(union.length);
    const standalone = new Set();
    for (const reader of [defaultListOpenPrs, listConflicts, listProgress, defaultReadPrs]) {
      reader({ exec: (cmd, args) => {
        expect(cmd).toBe('gh');
        for (const field of args[args.indexOf('--json') + 1].split(',')) standalone.add(field);
        return '[]';
      } });
    }
    expect([...standalone].sort()).toEqual([...union].sort());
  });

  it.each([null, 'owner/repo'])('uses runGhSync by default with the full query (repo %s)', (repo) => {
    const prs = [{ number: 123, comments: [{ body: 'retained' }], files: [{ path: 'a.mjs' }] }];
    runGhSync.mockReset().mockReturnValue(JSON.stringify(prs));
    expect(defaultFetchOpenPrs({ repo })).toEqual(prs);
    expect(runGhSync).toHaveBeenCalledTimes(1);
    expect(runGhSync).toHaveBeenCalledWith(
      ['pr', 'list', '--state', 'open', '--limit', '200', '--json', OPEN_PR_LIST_FIELDS, ...(repo ? ['--repo', repo] : [])],
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  });

  it.each(['', undefined, '{}', 'null'])('tolerates falsy or non-array output: %s', (out) => {
    expect(defaultFetchOpenPrs({ exec: () => out })).toEqual([]);
  });

  it('propagates fetch/parse failures so the runner can fall back', () => {
    expect(() => defaultFetchOpenPrs({ exec: () => { throw new Error('throttled'); } })).toThrow('throttled');
    expect(() => defaultFetchOpenPrs({ exec: () => '{broken' })).toThrow();
  });
});

describe('fetchOpenPrsRest — build-dispatch daemon field parity (#4351 follow-up, guided by #4309 spend accounting)', () => {
  it('BUILD_DISPATCH_PR_FIELDS pins the five fields supplied by the REST mapper', () => {
    expect(BUILD_DISPATCH_PR_FIELDS).toEqual(['number', 'headRefName', 'labels', 'files', 'isDraft']);
  });

  it('guards the real normalizer against reads outside the REST producer contract', () => {
    const reads = new Set();
    const prs = FIXTURE.restPulls.map((p) => {
      const row = restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]);
      expect(Reflect.ownKeys(row).sort()).toEqual([...BUILD_DISPATCH_PR_FIELDS].sort());
      return guardPrReads(row, reads);
    });
    const normalized = normalizeOpenPrs([{ repo: 'we', prs }]);
    expect(normalized.length).toBeGreaterThan(0);
    expect(normalized).toEqual(normalizeOpenPrs([{ repo: 'we', prs: FIXTURE.graphql }]));
    expect([...reads].sort()).toEqual(['files', 'headRefName', 'labels', 'number']);
  });

  it('rejects an undeclared optional read and records the offending field', () => {
    const p = FIXTURE.restPulls[0];
    const reads = new Set();
    const row = guardPrReads(restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]), reads);
    expect(() => row.body).toThrow('PR field body is outside the supplied contract');
    expect([...reads]).toEqual(['body']);
  });

  it('rejects a missing own field even when normalization would tolerate undefined', () => {
    const p = FIXTURE.restPulls[0];
    const row = restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]);
    delete row.headRefName;
    expect(normalizeOpenPrs([{ repo: 'we', prs: [row] }])[0].headRefName).toBe('');
    // An inherited value must not satisfy the producer's own-property contract either.
    Object.setPrototypeOf(row, { headRefName: undefined });
    expect(() => normalizeOpenPrs([{ repo: 'we', prs: [guardPrReads(row)] }]))
      .toThrow('PR field headRefName is missing from the supplied row');
  });

  it('maps a REST pulls item + its own files page to exactly what the old GraphQL query returned', () => {
    const mapped = FIXTURE.restPulls.map((p) => restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]));
    expect(mapped).toEqual(FIXTURE.graphql);
  });

  it('normalizeOpenPrs reads the REST-mapped rows identically to the old GraphQL rows', () => {
    const viaGraphql = normalizeOpenPrs([{ repo: 'we', prs: FIXTURE.graphql }]);
    const restMapped = FIXTURE.restPulls.map((p) => restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]));
    const viaRest = normalizeOpenPrs([{ repo: 'we', prs: restMapped }]);
    expect(viaRest).toEqual(viaGraphql);
    expect(viaRest.length).toBeGreaterThan(0); // the parity check above must not be vacuous
  });

  function scripted(responses) {
    const calls = [];
    const exec = (file, argv) => {
      calls.push(argv);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    };
    return { exec, calls };
  }
  const httpOk = (body, etag = 'W/"e1"') => `HTTP/2.0 200 OK\r\n${etag ? `Etag: ${etag}\r\n` : ''}\r\n${body}`;

  it('lists open PRs then each one\'s own files page via REST `gh api` — never `gh pr` (graphql)', () => {
    const { exec, calls } = scripted([
      httpOk(JSON.stringify(FIXTURE.restPulls)),
      httpOk(JSON.stringify(FIXTURE.restFiles['2901'])),
      httpOk(JSON.stringify(FIXTURE.restFiles['2902'])),
    ]);
    const rows = fetchOpenPrsRest({ repo: 'web-everything/web-everything', exec, env: { VITEST: '1' } });
    expect(rows).toEqual(FIXTURE.graphql);
    expect(calls).toEqual([
      ['api', '-i', 'repos/web-everything/web-everything/pulls?state=open&per_page=100&page=1'],
      ['api', '-i', 'repos/web-everything/web-everything/pulls/2901/files?per_page=100&page=1'],
      ['api', '-i', 'repos/web-everything/web-everything/pulls/2902/files?per_page=100&page=1'],
    ]);
    expect(calls.every((argv) => argv[0] !== 'pr')).toBe(true);
  });

  it('tolerates a PR with no files (an empty page, never a crash)', () => {
    const { exec } = scripted([httpOk(JSON.stringify([FIXTURE.restPulls[0]])), httpOk('[]')]);
    expect(fetchOpenPrsRest({ repo: 'o/r', exec, env: { VITEST: '1' } })[0].files).toEqual([]);
  });
});

describe('snapshot reader', () => {
  it('reads the exact path as UTF-8 and preserves the whole array', () => {
    const prs = [{ number: 1, labels: [], files: [], body: 'text' }];
    const readFile = mock(() => JSON.stringify(prs));
    expect(readPrsFromFile('/tmp/snapshot.json', { readFile })).toEqual(prs);
    expect(readFile).toHaveBeenCalledWith('/tmp/snapshot.json', 'utf8');
  });
  it.each(['{broken', '{}', 'null', '3', '"text"', ''])('returns an empty list for invalid snapshot %s', (content) => {
    expect(readPrsFromFile('unused', { readFile: () => content })).toEqual([]);
  });
  it('returns an empty list for unreadable files', () => {
    expect(readPrsFromFile('unused', { readFile: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });
});
