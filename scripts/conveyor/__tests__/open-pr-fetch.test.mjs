import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defaultFetchOpenPrs, readPrsFromFile, OPEN_PR_LIST_FIELDS, PR_LIST_LIMIT,
  fetchOpenPrsRest, restPullToBuildDispatchShape, BUILD_DISPATCH_PR_FIELDS,
} from '../open-pr-fetch.mjs';
import { runGhSync } from '../../lib/gh-throttle.mjs';
import { resolveCheckAppsByCommit, mapGraphqlPr } from '../../lib/pr-list-paged.mjs';
import { resolveRequiredChecks } from '../../lib/check-state-predicate.mjs';
import { normalizeOpenPrs } from '../build-dispatch-policy.mjs';
import { defaultListOpenPrs } from '../duplicate-pr-watch.mjs';
import { defaultListParkedPrs as listConflicts } from '../parked-pr-conflict-watch.mjs';
import { defaultListParkedPrs as listProgress } from '../parked-pr-progress-watch.mjs';
import { defaultReadPrs } from '../reconcile-pass.mjs';

// `execFileSyncThrottled`/`runGhSync` are mocked (existing tests drive `runGhSync` directly); every OTHER
// export (`ghAuthIdentity`, `deriveGhCaller`, `ghThrottleLockRoot`, …) stays REAL via `importOriginal` — the
// REST-path tests below pass their own `exec`, but still call through `gh-rest-read.mjs#ghRestGetJson`, which
// needs those real, pure helpers to resolve an identity/cache key. The end-to-end "real throttle" proof (no
// mocking at all) lives in its own file, `open-pr-fetch-rest-live.test.mjs`.
vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => ({ ...(await importOriginal()), runGhSync: vi.fn(), execFileSyncThrottled: vi.fn() }));

const FIXTURE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-prs-rest-vs-graphql.json'), 'utf8',
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
    expect(defaultFetchOpenPrs({ repo })).toEqual(prs.map(pr => ({ ...pr, rowsComplete: false, rowsHead: null })));
    expect(runGhSync).toHaveBeenCalledTimes(1);
    expect(runGhSync).toHaveBeenCalledWith(
      ['pr', 'list', '--state', 'open', '--limit', '200', '--json', OPEN_PR_LIST_FIELDS, ...(repo ? ['--repo', repo] : [])],
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  });

  it.each(['', undefined, '{}', 'null'])('tolerates falsy or non-array output: %s', (out) => {
    expect(defaultFetchOpenPrs({ exec: () => out })).toEqual([]);
  });

  describe('check-app provenance on the runner tick snapshot (#6926)', () => {
    const SHA = 'a'.repeat(40);
    const redTeam = { __typename: 'CheckRun', name: 'red-team', workflowName: '', status: 'IN_PROGRESS', conclusion: '' };
    const done = { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' };
    const row = (rollup, sha = SHA, number = 1) => ({ number, headRefOid: sha, statusCheckRollup: rollup.map((c) => ({ ...c })) });
    const mkExec = (rows, apiRuns, calls, total) => (args) => {
      if (args[0] !== 'api') return JSON.stringify(rows);
      calls.push(args[1]);
      if (apiRuns instanceof Error) throw apiRuns;
      const runs = apiRuns.map((r) => ({ status: 'in_progress', ...r }));
      return JSON.stringify({ total_count: total ?? runs.length, check_runs: runs });
    };
    const run = (rows, apiRuns, { repo = 'o/r', total } = {}) => {
      const calls = [];
      return { out: defaultFetchOpenPrs({ repo, exec: mkExec(rows, apiRuns, calls, total), readComments: () => [] }), calls };
    };
    const live = (out, i = 0) => out[i].statusCheckRollup.find((c) => c.name === 'red-team');
    const configured = { id: 9, name: 'red-team', app: { id: 5037855, slug: 'web-everything' } };

    it('binds the posting app of a live workflow-less check from the head commit check runs', () => {
      const { out, calls } = run([row([done, redTeam])], [configured]);
      expect(live(out)).toMatchObject({ appId: 5037855, appSlug: 'web-everything' });
      expect(calls).toEqual([`repos/o/r/commits/${SHA}/check-runs?per_page=100&filter=all`]);
    });

    it('uses gh placeholders when no repo is given', () => {
      const { calls } = run([row([redTeam])], [], { repo: null });
      expect(calls).toEqual([`repos/{owner}/{repo}/commits/${SHA}/check-runs?per_page=100&filter=all`]);
    });

    it('makes no extra read when every check is completed, workflow-backed or already has an app', () => {
      const { calls } = run([row([done, { ...redTeam, workflowName: 'CI' }, { ...redTeam, appId: 1, appSlug: 's' }])], []);
      expect(calls).toEqual([]);
    });

    it('never puts a non-SHA headRefOid in the API path', () => {
      const { calls } = run([row([redTeam], '../../x?y=1')], [configured]);
      expect(calls).toEqual([]);
    });

    it.each([
      ['an unreadable read', new Error('boom'), undefined],
      ['no matching run', [{ id: 1, name: 'other', app: { id: 5 } }], undefined],
      ['a run without an app', [{ id: 1, name: 'red-team', app: null }], undefined],
      ['same-name runs from two apps', [{ id: 1, name: 'red-team', app: { id: 5, slug: 'a' } }, { id: 2, name: 'red-team', app: { id: 6, slug: 'b' } }], undefined],
      ['a partial page (total_count above the runs returned)', [configured], 101],
      ['same-name runs that are all completed', [{ ...configured, status: 'completed' }], undefined],
    ])('fails closed (no app) on %s', (_label, apiRuns, total) => {
      expect(live(run([row([redTeam])], apiRuns, { total }).out)).not.toHaveProperty('appId');
    });

    it('bounds commit reads per list and advances after unsuccessful reads', () => {
      const rows = Array.from({ length: 70 }, (_, i) => row([redTeam], String(i).padStart(2, '0').padEnd(40, 'b'), i + 1));
      const seen = new Set();
      for (let refresh = 0; refresh < 3; refresh++) {
        const calls = [];
        resolveCheckAppsByCommit({ repo: 'o/rot', rows: structuredClone(rows), exec: (_c, args) => mkExec(rows, [], calls)(args) });
        expect(calls).toHaveLength(30);
        calls.forEach((c) => seen.add(c));
      }
      expect(seen.size).toBe(70);
    });

    it('hydrates all 40 heads across fresh runner processes at two-minute intervals', () => {
      const dir = mkdtempSync(join(tmpdir(), 'commit-app-progress-'));
      const seen = new Set();
      const moduleUrl = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../open-pr-fetch.mjs')).href;
      try {
        for (const now of [0, 120000, 240000, 360000, 480000]) {
          const script = `
            import { defaultFetchOpenPrs } from ${JSON.stringify(moduleUrl)};
            Date.now = () => ${now};
            const rows = Array.from({ length: 40 }, (_, i) => ({ number: i + 1,
              headRefOid: (i + 1).toString(16).padStart(40, '0'), statusCheckRollup: [{
                __typename: 'CheckRun', name: 'red-team', status: 'IN_PROGRESS',
              }] }));
            let calls = 0;
            const out = defaultFetchOpenPrs({ repo: 'progress/runner', readComments: () => [],
              exec: args => {
                if (args[0] !== 'api') return JSON.stringify(rows);
                calls++;
                return JSON.stringify({ total_count: 1, check_runs: [{ name: 'red-team',
                  status: 'in_progress', app: { id: 5037855, slug: 'web-everything' } }] });
              } });
            console.log(JSON.stringify({ calls, hydrated: out.filter(r =>
              r.statusCheckRollup[0].appId === 5037855).map(r => r.headRefOid) }));
          `;
          const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
            env: { ...process.env, WE_PR_SNAPSHOT_DIR: dir }, encoding: 'utf8', timeout: 10000,
          }));
          expect(result.calls).toBe(30);
          result.hydrated.forEach(sha => seen.add(sha));
        }
        expect(seen.size).toBe(40);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  it('propagates fetch/parse failures so the runner can fall back', () => {
    expect(() => defaultFetchOpenPrs({ exec: () => { throw new Error('throttled'); } })).toThrow('throttled');
    expect(() => defaultFetchOpenPrs({ exec: () => '{broken' })).toThrow();
  });
});

describe('fetchOpenPrsRest — build-dispatch daemon field parity (#4351 follow-up, guided by #4309 spend accounting)', () => {
  it('BUILD_DISPATCH_PR_FIELDS pins the fields supplied by the REST mapper', () => {
    expect(BUILD_DISPATCH_PR_FIELDS).toEqual(['number', 'headRefName', 'body', 'labels', 'files', 'isDraft']);
  });

  it('preserves the mechanical body provenance through the REST fetch and normalization', () => {
    const body = 'Delivered by the #3627 minimal delivery-agent pipeline';
    const row = restPullToBuildDispatchShape({ number: 1, head: { ref: 'lane/42-feature' }, body });
    expect(normalizeOpenPrs([{ repo: 'we', prs: [row] }])[0].body).toBe(body);
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
    expect([...reads].sort()).toEqual(['body', 'files', 'headRefName', 'labels', 'number']);
  });

  it('rejects an undeclared optional read and records the offending field', () => {
    const p = FIXTURE.restPulls[0];
    const reads = new Set();
    const row = guardPrReads(restPullToBuildDispatchShape(p, FIXTURE.restFiles[String(p.number)]), reads);
    expect(() => row.title).toThrow('PR field title is outside the supplied contract');
    expect([...reads]).toEqual(['title']);
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
    expect(mapped).toEqual(FIXTURE.graphql.map(p => ({ ...p, body: p.body ?? '' })));
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
    expect(rows).toEqual(FIXTURE.graphql.map(p => ({ ...p, body: p.body ?? '' })));
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
    const readFile = vi.fn(() => JSON.stringify(prs));
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


describe('rollup connection completeness at the fetch boundary', () => {
  const head = 'a'.repeat(40);
  const nodes = [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  it.each([
    ['complete', { pageInfo: { hasNextPage: false }, totalCount: 1, nodes }, true],
    ['paged failure', { pageInfo: { hasNextPage: true }, totalCount: 2,
      nodes: [{ __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: 'FAILURE' }] }, false],
    ['paged', { pageInfo: { hasNextPage: true }, totalCount: 1, nodes }, false],
    ['count mismatch', { pageInfo: { hasNextPage: false }, totalCount: 2, nodes }, false],
    ['missing pageInfo', { totalCount: 1, nodes }, false],
    ['invalid count', { pageInfo: { hasNextPage: false }, totalCount: '1', nodes }, false],
    ['missing nodes', { pageInfo: { hasNextPage: false }, totalCount: 0 }, false],
    ['malformed row', { pageInfo: { hasNextPage: false }, totalCount: 1, nodes: [{}] }, false],
    ['empty complete', { pageInfo: { hasNextPage: false }, totalCount: 0, nodes: [] }, true],
  ])('%s metadata determines GraphQL evidence without changing mapped rows', (_name, contexts, complete) => {
    const commit = { oid: head, statusCheckRollup: { contexts } };
    const mapped = mapGraphqlPr({ headRefOid: head, commits: { nodes: [{ commit }] } });
    expect(mapped).toMatchObject({ rowsHead: head, rowsComplete: complete });
    // Connection metadata must not change which rows main's mapper returns.
    const withoutMetadata = mapGraphqlPr({ commits: { nodes: [{ commit: {
      statusCheckRollup: { contexts: { nodes: contexts.nodes } },
    } }] } });
    expect(mapped.statusCheckRollup).toEqual(withoutMetadata.statusCheckRollup);
    if (_name === 'paged failure') expect(mapped.statusCheckRollup[0].conclusion).toBe('FAILURE');
  });
});

it.each(['SUCCESS', 'FAILURE', 'PENDING', 'empty'])(
  'legacy %s rows remain unchanged with unknown evidence and no rollup refresh', state => {
    const head = 'a'.repeat(40);
    const listed = state === 'empty' ? [] : [
      { __typename: 'CheckRun', name: 'gate', status: 'COMPLETED', conclusion: state },
      { __typename: 'StatusContext', context: 'legacy', state },
    ];
    const exec = vi.fn(() => JSON.stringify([{ number: 1, headRefOid: head, statusCheckRollup: listed }]));
    const pr = defaultFetchOpenPrs({ repo: 'o/r', exec, readComments: () => [] })[0];
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0].slice(0, 2)).toEqual(['pr', 'list']);
    expect(pr).toMatchObject({ rowsHead: null, rowsComplete: false, statusCheckRollup: listed });
    expect(resolveRequiredChecks({ head, rowsHead: pr.rowsHead, rowsComplete: pr.rowsComplete,
      rows: pr.statusCheckRollup, requiredNames: ['gate'], rosterSource: 'live' }).state).toBe('unknown');
  });
