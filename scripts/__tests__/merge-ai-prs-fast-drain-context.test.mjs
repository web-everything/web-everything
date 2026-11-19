import { test as nodeTest } from 'node:test';
const test = process.env.VITEST ? (await import('vitest')).it : nodeTest;
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readFastDrainContext, relatedFastDrainPrs, fastDrainPrKey, useFastDrainContext,
  fastDrainListingAfterBranches, validateLeanOpenPrs, listLeanOpenPrsPaged, LEAN_OPEN_PR_FIELDS } from '../lib/fast-drain-context.mjs';
import { cachedDefaultBranch, DEFAULT_BRANCH_CACHE_TTL_MS, resolveCachedDefaultBranch, createLiveDefaultBranchReader } from '../lib/default-branch-cache.mjs';
import { readSharedOpenPrs, SNAPSHOT_FIELDS, DEFAULT_TTL_MS } from '../lib/pr-snapshot.mjs';
import { snapshotPath, PR_SNAPSHOT_VERSION, markPrSnapshotDirty } from '../lib/pr-snapshot-store.mjs';
import { resolveFastDrainListingSetting } from '../lib/fast-drain-scope.mjs';
import { OPEN_PR_LIST_LIMIT } from '../lib/no-search-backed-pr-list.mjs';
import { runFastDrainContextCli } from './fixtures/fast-drain-context-cli.mjs';

process.env.WE_UNDER_TEST = '1';
const { planLabelDrain, revalidateForMerge } = await import('../merge-ai-prs.mjs');
const repo = 'fixture/repo', other = 'fixture/frontierui';
const manifest = (item, blockedBy = [], stackParents = []) => ({ item, blockedBy, stackParents, repos: [] });
const pr = (number, extra = {}) => ({
  number, headRefOid: number.toString(16).padStart(40, '0'), updatedAt: '2026-11-18T12:00:00Z',
  headRefName: `lane/${number}`, baseRefName: 'main', isDraft: false, state: 'OPEN',
  title: `PR ${number}`, body: 'Fixture PR body', labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }],
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED',
  files: [{ path: `src/${number}.mjs` }], statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  rowsHead: number.toString(16).padStart(40, '0'), rowsComplete: true, ...extra,
});
const inventory = (rows, extra = {}) => ({ rows, totalCount: rows.length, hasNextPage: false, truncated: false, ...extra });
const lean = p => Object.fromEntries(LEAN_OPEN_PR_FIELDS.split(',').map(f => [f, p[f]]));

async function run({ snapshot = [pr(7), pr(8)], live = snapshot, full = live, leanRead, snapshotRead,
  readFull, groups, setting = {}, enabled = true, repos = [repo], manifests = new Map() } = {}) {
  const calls = { fullPages: 0, contextRelists: 0, lean: [], full: [], phases: [], log: [] };
  const options = {
    repos, targetRepo: repo, onlyPr: 7,
    readSnapshot: snapshotRead ?? (() => snapshot),
    listLean: async r => { calls.lean.push(r); return leanRead ? leanRead(r) : inventory(live.map(lean)); },
    readFull: async (r, n) => { calls.full.push([r, n]); return readFull ? readFull(r, n) : full.find(p => p.number === n); },
    readManifest: async (r, p) => manifests.get(fastDrainPrKey(r, p.number)) ?? p.manifest ?? null,
    readGroups: () => groups ?? { groups: [] },
    time: async (phase, f) => { calls.phases.push(phase); return f(); }, log: line => calls.log.push(line),
  };
  const policy = resolveFastDrainListingSetting({ env: {}, tool: {}, platform: {}, ...setting });
  let rows = enabled && useFastDrainContext({ onlyPr: 7, fromGreenEvent: true, localSlug: repo, ...policy })
    ? await readFastDrainContext(options) : null;
  if (!rows) {
    // These are the unchanged full-list and extra-context paths in the production caller.
    calls.fullPages++;
    calls.contextRelists++;
    rows = new Map([[repo, live]]);
  }
  return { rows, calls, policy };
}

function plan(rows) {
  const target = rows.get(repo).find(p => p.number === 7);
  const m = target.manifest ?? manifest(107);
  const open = [...rows.values()].flat().map(p => p.manifest?.item).filter(v => v != null);
  return planLabelDrain([{ num: 7, repo, headSha: target.headRefOid, decision: 'merge',
    item: m.item, blockedBy: m.blockedBy, stackParents: m.stackParents, hasManifest: true }],
  { extraOpenItems: open, contextComplete: true, isWeRepo: r => r === repo });
}

test('no-edge target reaches queue admission without full pages or a context re-list', async () => {
  const { rows, calls } = await run();
  const queued = [];
  for (const candidate of plan(rows).ready) {
    const target = rows.get(repo)[0];
    const gate = revalidateForMerge(target, { expectedHeadSha: candidate.headSha });
    if (gate.decision === 'merge') queued.push(candidate.num);
  }
  assert.deepEqual(queued, [7]);
  assert.equal(calls.fullPages, 0);
  assert.equal(calls.contextRelists, 0);
  assert.deepEqual(calls.lean, [repo]);
  assert.deepEqual(calls.full, [[repo, 7]]);
  assert.deepEqual(calls.phases, ['listing.target', 'listing.lean', 'listing.related']);
});

test('an edged target refreshes exactly its component; a related PR closed only live clears the blocker', async () => {
  const target = pr(7, { manifest: manifest(107, [108]) });
  const blocker = pr(8, { manifest: manifest(108) });
  const snapshot = [target, blocker, pr(9)];
  assert.equal(plan(new Map([[repo, snapshot]])).ready.length, 0);
  const { rows, calls } = await run({ snapshot, full: [target, { ...blocker, state: 'CLOSED', labels: [{ name: 'review:changes' }] }, pr(9)] });
  assert.deepEqual(calls.full, [[repo, 7], [repo, 8]]);
  assert.deepEqual(rows.get(repo).map(p => p.number), [7, 9]);
  assert.equal(plan(rows).ready.length, 1);
});

test('a PR opened after the snapshot is hydrated live and its blockedBy relationship is honoured', async () => {
  const target = pr(7, { manifest: manifest(107, [108]) });
  const blocker = pr(8, { manifest: manifest(108), labels: [], baseRefName: 'develop' });
  const { rows, calls } = await run({ snapshot: [target], live: [target, blocker] });
  assert.deepEqual(calls.full, [[repo, 7], [repo, 8]]);
  assert.equal(calls.fullPages, 0);
  assert.equal(plan(rows).ready.length, 0);
  assert.ok(plan(rows).deferred[0].waitOn.includes(108));
});

test('a related live row can expose another edge, which is also refreshed before returning', async () => {
  const snapshot = [pr(7, { manifest: manifest(107, [108]) }), pr(8, { manifest: manifest(108) }), pr(9, { manifest: manifest(109) }), pr(10)];
  const full = snapshot.map(p => p.number === 8 ? { ...p, manifest: manifest(108, [109]) } : p);
  const { calls, rows } = await run({ snapshot, full });
  assert.deepEqual(calls.full, [[repo, 7], [repo, 8], [repo, 9]]);
  assert.deepEqual(rows.get(repo)[1].manifest.blockedBy, [109]);
});

test('head or updatedAt mismatches hydrate full rows; closed snapshot rows are dropped', async () => {
  const snapshot = [pr(7), pr(8), pr(9), pr(10)];
  const live = [pr(7), pr(8, { headRefOid: 'b'.repeat(40) }), pr(9, { updatedAt: '2026-11-18T12:01:00Z', body: 'edited' })];
  const { rows, calls } = await run({ snapshot, live });
  assert.deepEqual(rows.get(repo), live);
  assert.deepEqual(calls.full, [[repo, 7], [repo, 8], [repo, 9]]);
});

test('a target changed between its first full read and the lean inventory is read fully again', async () => {
  const old = pr(7), changed = pr(7, { body: 'new dependency', updatedAt: '2026-11-18T12:01:00Z', manifest: manifest(107, [108]) });
  let reads = 0;
  const { rows, calls } = await run({ snapshot: [changed], live: [changed], readFull: () => ++reads === 1 ? old : changed });
  assert.equal(rows.get(repo)[0].body, 'new dependency');
  assert.deepEqual(calls.full, [[repo, 7], [repo, 7]]);
});

test('a head moved after the context read defers at the existing head pin and is not enqueued', async () => {
  const { rows } = await run();
  const target = rows.get(repo)[0];
  const gate = revalidateForMerge({ ...target, headRefOid: 'f'.repeat(40) }, { expectedHeadSha: target.headRefOid });
  const queued = gate.decision === 'merge' ? [7] : [];
  assert.deepEqual(queued, []);
  assert.equal(gate.decision, 'skip');
  assert.match(gate.reason, /head moved since the pass-start decision/);
});

for (const reason of ['unavailable', 'stale', 'dirty', 'disabled']) {
  test(`snapshot ${reason} falls back without refreshing the snapshot`, async () => {
    const dir = mkdtempSync(join(process.env.TMPDIR, 'fast-context-'));
    const nowMs = Date.now();
    const env = { WE_PR_SNAPSHOT_DIR: dir, WE_PR_SNAPSHOT: reason === 'disabled' ? '0' : '1', WE_PR_SNAPSHOT_STALE_OK_MS: '3600000' };
    try {
      const age = reason === 'stale' ? DEFAULT_TTL_MS : 20_000;
      if (reason !== 'unavailable') writeFileSync(snapshotPath(dir, repo), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
        repo, prs: [pr(7)], fields: SNAPSHOT_FIELDS, fetchedAtMs: nowMs - age }));
      if (reason === 'dirty') markPrSnapshotDirty({ repo, env, nowMs });
      let refreshCalls = 0;
      const { calls } = await run({ snapshotRead: r => readSharedOpenPrs({ repo: r, fields: SNAPSHOT_FIELDS,
        env, now: () => nowMs, cacheOnly: true, exec: () => { refreshCalls++; throw new Error('must not refresh'); } }) });
      assert.equal(refreshCalls, 0);
      assert.equal(calls.fullPages, 1);
      assert.equal(calls.contextRelists, 1);
      assert.equal(calls.log.length, 1);
      assert.match(calls.log[0], /^fast-drain: context fell back to full listing \(.+\)$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

{
  const cases = {
    snapshotThrows: { snapshotRead: () => { throw new Error('snapshot read failed'); } },
    leanThrows: { leanRead: () => { throw new Error('lean read failed'); } },
    leanMalformed: { leanRead: () => inventory([{ number: 8 }]) },
    leanDuplicate: { leanRead: () => inventory([lean(pr(7)), lean(pr(7))]) },
    leanTruncated: { leanRead: () => inventory(Array.from({ length: OPEN_PR_LIST_LIMIT }, (_, i) => lean(pr(i + 1)))) },
    unknownGroups: { groups: { unreadable: true } },
    partialTarget: { readFull: () => ({ number: 7, state: 'OPEN' }) },
    relatedUnreadable: { snapshot: [pr(7, { manifest: manifest(107, [108]) }), pr(8, { manifest: manifest(108) })], readFull: (_r, n) => n === 7 ? pr(7, { manifest: manifest(107, [108]) }) : null },
  };
  for (const [name, options] of Object.entries(cases)) test(`${name} falls back to full listing once`, async () => {
    const { calls } = await run(options);
    assert.equal(calls.fullPages, 1);
    assert.equal(calls.log.length, 1);
  });
}

test('incomplete cached check evidence is hydrated live rather than trusted', async () => {
  const { calls } = await run({ snapshot: [pr(7), pr(8, { rowsComplete: false })] });
  assert.deepEqual(calls.full, [[repo, 7], [repo, 8]]);
});

test('edges include both dependency directions, stack, couple, overlap, transitive card group and cross-repo siblings', () => {
  const entries = [
    { repo, p: pr(7), manifest: { ...manifest('xaaaaaa'), repos: [{ ref: 'lane/12', repo: 'frontierui' }] } },
    { repo, p: pr(8), manifest: manifest('xbbbbbb', ['xaaaaaa']) },
    { repo, p: pr(9), manifest: manifest('xcccccc', [], ['xaaaaaa']) },
    { repo, p: pr(10, { files: [{ path: 'src/7.mjs' }] }), manifest: null },
    { repo, p: pr(11), manifest: null },
    { repo: other, p: pr(12), manifest: null },
    { repo, p: pr(13), manifest: null },
  ];
  const related = relatedFastDrainPrs(entries, fastDrainPrKey(repo, 7), [{ repo, pr: 11, sources: [{ num: 10 }] }]);
  assert.deepEqual([...related].sort(), [8, 9, 10, 11].map(n => fastDrainPrKey(repo, n)).concat(fastDrainPrKey(other, 12)).sort());
});

test('same PR number in another repo does not replace the target; each context repo gets one lean read', async () => {
  const { calls, rows } = await run({ repos: [repo, other], snapshotRead: r => r === repo ? [pr(7)] : [pr(7, { body: 'other repo' })],
    leanRead: () => inventory([lean(pr(7))]) });
  assert.deepEqual(calls.lean, [repo, other]);
  assert.deepEqual(calls.full, [[repo, 7]]);
  assert.equal(rows.get(other)[0].body, 'other repo');
});

test('policy provenance follows standard/platform/tool/env and either live kill switch restores full listing', async () => {
  const base = { env: {}, tool: {}, platform: {} };
  assert.equal(resolveFastDrainListingSetting(base).contextSource, 'standard');
  assert.equal(resolveFastDrainListingSetting({ ...base, platform: { context: 'live' } }).contextSource, 'platform');
  assert.equal(resolveFastDrainListingSetting({ ...base, tool: { context: 'live' } }).contextSource, 'tool');
  const toolOff = await run({ setting: { tool: { context: 'live' } } });
  assert.equal(toolOff.calls.fullPages, 1);
  assert.deepEqual(toolOff.calls.lean, []);
  assert.match(toolOff.policy.line, /context=live \(tool\)/);
  for (const env of [{ WE_FAST_DRAIN_CONTEXT: 'live' }, { WE_FAST_DRAIN_LISTING: 'live' }]) {
    const { calls, policy } = await run({ setting: { env } });
    assert.equal(calls.fullPages, 1);
    assert.equal(calls.contextRelists, 1);
    assert.equal(calls.lean.length, 0);
    assert.match(policy.line, /live \(env\)/);
  }
  const invalid = resolveFastDrainListingSetting({ ...base, env: { WE_FAST_DRAIN_CONTEXT: 'bad' } });
  assert.equal(invalid.context, 'snapshot');
  assert.match(invalid.line, /ignored invalid/);
});

test('full batch, non-event and explicitly remote targets keep their original paths', () => {
  const options = { onlyPr: 7, fromGreenEvent: true, localSlug: repo, listing: 'snapshot', context: 'snapshot' };
  for (const patch of [{ onlyPr: null }, { fromGreenEvent: false }, { onlyRepo: other }, { localSlug: null }]) {
    assert.equal(useFastDrainContext({ ...options, ...patch }), false);
  }
  assert.equal(useFastDrainContext({ ...options, onlyRepo: repo }), true);
});

test('default branch cache rejects stale, future, missing and ambiguous names', () => {
  assert.equal(cachedDefaultBranch({ name: 'main', atMs: 10 }, 20), 'main');
  for (const cached of [null, { name: '', atMs: 10 }, { name: 'main\nother', atMs: 10 }, { name: 'main', atMs: 21 }, { name: 'main', atMs: 20 - DEFAULT_BRANCH_CACHE_TTL_MS }]) {
    assert.equal(cachedDefaultBranch(cached, 20), null);
  }
});

test('failed live default-branch resolution fails closed even with a cached hint', async () => {
  const warnings = [], map = new Map();
  const verify = createLiveDefaultBranchReader({ map, readLive: async () => { throw new Error('fixture branch unreadable'); },
    warn: e => warnings.push(e.message) });
  const branch = await verify(repo);
  assert.deepEqual(warnings, ['fixture branch unreadable']);
  assert.equal(map.get(repo), null);
  const verdict = revalidateForMerge(pr(7), { defaultBranch: branch });
  assert.equal(verdict.decision, 'skip');
  assert.match(verdict.reason, /default branch unresolved live.*deferring merge\/enqueue/);
  for (const killSwitch of [false, true]) {
    const live = runFastDrainContextCli({ failDefaultBranch: true, cachedBranch: 'main', killSwitch });
    assert.equal(live.status, 0, live.stderr);
    const result = JSON.parse(live.stdout);
    assert.deepEqual(result.toMerge, []);
    assert.deepEqual(result.enqueueOutcomes ?? [], []);
    assert.ok(result.skipped.some(v => /default branch unresolved live/.test(v.reason)), live.stdout);
    assert.match(live.stderr, /default branch unresolved live .* — deferring merge\/enqueue/);
  }
});

test('gate-time live branch read starts after synchronous pages and never uses a hint as authority', async () => {
  const events = [], hints = new Map();
  const verify = createLiveDefaultBranchReader({ readLive: async () => {
    events.push('live start'); await setImmediate(); events.push('live done'); return 'develop';
  }, writeCache: () => {} });
  await fastDrainListingAfterBranches({
    resolveBranches: () => resolveCachedDefaultBranch({ repo, map: hints, readCache: () => 'main' }),
    list: () => { events.push('sync pages done'); },
  });
  assert.deepEqual(events, ['sync pages done']);
  assert.equal(await verify(repo), 'develop');
  assert.deepEqual(events, ['sync pages done', 'live start', 'live done']);
});

test('cached main and parent round main cannot authorize a PR when live default is develop', () => {
  for (const killSwitch of [false, true]) {
    const live = runFastDrainContextCli({ cachedBranch: 'main', roundBranch: 'main', liveDefaultBranch: 'develop', killSwitch });
    assert.equal(live.status, 0, live.stderr);
    const result = JSON.parse(live.stdout);
    assert.deepEqual(result.toMerge, []);
    assert.ok(result.skipped.some(v => v.num === 7 && v.reason === 'base is not develop (main)'), live.stdout);
    assert.equal(live.cachedBranch, 'develop');
    const branchCalls = live.calls.filter(a => a[0] === 'repo' && a[1] === 'view');
    assert.equal(branchCalls.length, 1);
    const branchIndex = live.calls.indexOf(branchCalls[0]);
    assert.ok(live.calls.every((a, i) => !(a[0] === 'pr' && a[1] === 'list'
      || a[0] === 'api' && a.some(v => v.includes('pullRequests(states:OPEN'))) || i < branchIndex));
    if (!killSwitch) assert.equal(live.fullListings, 0);
  }
});

test('lean inventory validation rejects an unknown state and never requests heavy fields', () => {
  assert.throws(() => validateLeanOpenPrs(inventory([{ ...lean(pr(7)), state: 'CLOSED' }])), /incomplete/);
  assert.deepEqual(LEAN_OPEN_PR_FIELDS.split(','), ['number', 'headRefOid', 'updatedAt', 'baseRefName', 'isDraft', 'state']);
});

test('real CLI uses lean context for all repos and no full listing; live kill switch restores pages', () => {
  const fast = runFastDrainContextCli();
  assert.equal(fast.status, 0, fast.stderr);
  assert.equal(fast.fullListings, 0, fast.stderr);
  assert.equal(fast.heavyListings, 0);
  assert.equal(fast.leanListings, 3);
  const live = runFastDrainContextCli({ killSwitch: true });
  assert.equal(live.status, 0, live.stderr);
  assert.ok(live.fullListings > 0);
  assert.equal(live.leanListings, 0);
});

const leanPage = (rows, totalCount, hasNextPage = false, endCursor = null) => JSON.stringify({
  data: { repository: { pullRequests: { nodes: rows, totalCount, pageInfo: { hasNextPage, endCursor } } } },
});

async function pagedContext(pages, options = {}) {
  const queries = [];
  const result = await run({ leanRead: () => listLeanOpenPrsPaged({ repo, ...options, readPage: async query => {
    queries.push(query);
    const page = pages[queries.length - 1];
    if (page instanceof Error) throw page;
    return page;
  } }) });
  return { ...result, queries };
}

test('lean totalCount 2 with only 1 returned PR falls back through the full-list completeness guard', async () => {
  const { calls } = await pagedContext([leanPage([lean(pr(7))], 2)]);
  assert.equal(calls.fullPages, 1);
  assert.equal(calls.contextRelists, 1);
  assert.match(calls.log[0], /1 unique of 2 open PRs/);
});

test('two lean GraphQL pages are accepted only after complete metadata and rows agree', async () => {
  const { calls, rows, queries } = await pagedContext([
    leanPage([lean(pr(7))], 2, true, 'cursor"one'), leanPage([lean(pr(8))], 2),
  ], { pageSize: 1 });
  assert.equal(calls.fullPages, 0);
  assert.deepEqual(rows.get(repo).map(p => p.number), [7, 8]);
  assert.equal(new Set(rows.get(repo).map(p => p.number)).size, 2);
  assert.equal(queries.length, 2);
  assert.ok(queries[1].includes(`after:${JSON.stringify('cursor"one')}`));
  for (const query of queries) {
    assert.match(query, /orderBy:\{field:CREATED_AT,direction:DESC\}/);
    assert.match(query, /totalCount pageInfo\{hasNextPage endCursor\}/);
    assert.match(query, /nodes\{number headRefOid updatedAt baseRefName isDraft state\}/);
    assert.doesNotMatch(query, /statusCheckRollup|labels|body|files|commits/);
  }
});

for (const [name, second] of [
  ['transport page error', new Error('second lean page unreadable')],
  ['GraphQL page error with partial data', JSON.stringify({ errors: [{ message: 'partial lean page' }],
    data: JSON.parse(leanPage([lean(pr(8))], 2)).data })],
  ['truncated JSON page', '{'],
  ['missing final rows', leanPage([], 2)],
  ['duplicate hiding an omitted PR', leanPage([lean(pr(7))], 2)],
  ['a PR opened mid-read', leanPage([lean(pr(8))], 3)],
  ['a PR closed mid-read', leanPage([lean(pr(8))], 1)],
]) test(`${name} falls back instead of publishing a partial lean inventory`, async () => {
  const { calls } = await pagedContext([leanPage([lean(pr(7))], 2, true, 'next'), second], { pageSize: 1 });
  assert.equal(calls.fullPages, 1);
  assert.equal(calls.contextRelists, 1);
  assert.equal(calls.log.length, 1);
});

for (const [name, pages, options] of [
  ['a short intermediate page', [leanPage([lean(pr(7))], 3, true, 'next')], { pageSize: 2 }],
  ['unread hasNextPage at the bound', [leanPage([lean(pr(7))], 2, true, 'next')], { pageSize: 1, maxRows: 1 }],
  ['a repeated cursor', [leanPage([lean(pr(7))], 3, true, 'same'), leanPage([lean(pr(8))], 3, true, 'same')], { pageSize: 1 }],
  ['too many rows for totalCount', [leanPage([lean(pr(7)), lean(pr(8))], 1)], {}],
  ['duplicate numbers even if the unique count matches', [leanPage([lean(pr(7)), lean(pr(7))], 1)], {}],
  ['an oversized page', [leanPage([lean(pr(7)), lean(pr(8))], 2)], { pageSize: 1 }],
  ['a next page without a cursor', [leanPage([lean(pr(7))], 2, true)], { pageSize: 1 }],
  ['missing connection metadata', ['{}'], {}],
]) test(`${name} falls back to full listing`, async () => {
  const { calls } = await pagedContext(pages, options);
  assert.equal(calls.fullPages, 1);
  assert.equal(calls.log.length, 1);
});

test('uncertified flattened lean rows cannot bypass the shared inventory guard', async () => {
  const { calls } = await run({ leanRead: () => [lean(pr(7))] });
  assert.equal(calls.fullPages, 1);
});

test('real CLI falls back to full listing when lean GraphQL silently omits rows', () => {
  const live = runFastDrainContextCli({ leanIncomplete: true });
  assert.equal(live.status, 0, live.stderr);
  assert.ok(live.leanListings > 0);
  assert.ok(live.fullListings > 0);
  assert.match(live.stderr, /fast-drain: context fell back to full listing.*1 unique of 48/);
});

test('real CLI accepts a complete two-page lean inventory without heavy listing', () => {
  const live = runFastDrainContextCli({ rowCount: 101 });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.leanListings, 4);
  assert.equal(live.fullListings, 0);
  assert.equal(live.heavyListings, 0);
});

test('real CLI falls back when the second lean GraphQL page fails', () => {
  const live = runFastDrainContextCli({ rowCount: 101, leanPageError: true });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.leanListings, 2);
  assert.ok(live.fullListings > 0);
  assert.match(live.stderr, /fast-drain: context fell back to full listing.*fixture lean page error/);
});
