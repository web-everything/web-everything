import { mkdtempSync, rmSync, writeFileSync, readFileSync, truncateSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readFastDrainContext, readFastDrainPassInventory, LEAN_OPEN_PR_FIELDS, readFastDrainFacts } from '../lib/fast-drain-context.mjs';
import { readSharedOpenPrs, SNAPSHOT_FIELDS } from '../lib/pr-snapshot.mjs';
import { snapshotPath, PR_SNAPSHOT_VERSION, markPrSnapshotDirty } from '../lib/pr-snapshot-store.mjs';
import { runEnqueueCandidates } from '../lib/drain-concurrency.mjs';
import { overlapYieldWaits } from '../conveyor/land-overlap-yield.mjs';
import { reviewCiGate } from '../lib/review-ci-gate.mjs';
import fixture from './fixtures/fast-drain-18-prs.json';
import recorded from './fixtures/fast-drain-18-prs.recorded.json';
import { it, expect, describe } from 'vitest';
import { classifyChildFailure } from '../lib/child-failure-class.mjs';
import { runFastDrainContextCli } from './fixtures/fast-drain-context-cli.mjs';

it('negative first: catch-up retains a review:changes block under narrowed reads', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18,
    targetLabels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }] });
  expect(result.status, result.stderr).toBe(0);
  const decision = JSON.parse(result.stdout);
  expect(decision.toMerge).toEqual([]);
  expect(decision.skipped.some(p => p.num === 7 && /review/.test(p.reason))).toBe(true);
});

it('tier 1: catch-up without --from-green-event makes zero full-PR pagination calls', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.fullListings + result.heavyListings).toBe(0);
  expect(result.calls.filter(a => a[0] === 'pr' && a[1] === 'view' && a.includes('--json')
    && a[a.indexOf('--json') + 1].includes('body')).map(a => a[2])).toEqual(['7']);
});

it('CLI catch-up check/status reads use the default gh-throttle transport within a bounded call budget', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18, workflowEditSetting: 'off' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.bareCheckReads).toEqual([]);
  expect(JSON.parse(result.stdout).toMerge.map(p => p.num), result.stdout).toEqual([7]);
  const endpoints = result.calls.filter(a => a[0] === 'api')
    .flatMap(a => a.filter(v => /\/commits\/.*\/(check-runs|status)\?/.test(v)));
  const target = 'repos/fixture/web-everything/commits/' + '7'.padStart(40, '0');
  expect(endpoints).toEqual(expect.arrayContaining([
    `${target}/check-runs?per_page=100&filter=all`, `${target}/status?per_page=100`,
  ]));
  expect(endpoints).toHaveLength(2);
  expect(result.fullListings + result.heavyListings).toBe(0);
  // Includes the lean cross-repo membership and default-branch probes (27 calls
  // in the fixture); a small fixed ceiling catches repeated hydration/listing.
  expect(result.calls.length, JSON.stringify(result.calls)).toBeLessThanOrEqual(30);
});

it('catch-up excludes incomplete check evidence from the fast snapshot and reaches slow classification', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18,
    livePatches: { 7: { liveCheckRunPages: [] } } });
  expect(result.status, result.stderr).toBe(0);
  expect(result.leanListings).toBeGreaterThan(0);
  expect(result.fullListings + result.heavyListings).toBeGreaterThan(0);
  const decision = JSON.parse(result.stdout);
  expect(decision.toMerge).toEqual([]);
  expect(decision.skipped.some(p => p.num === 7 && /check evidence incomplete.*complete live check read/.test(p.reason))).toBe(true);
});

it('catch-up computes complete head-bound checks from PR views containing only requested gh fields', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18, workflowEditSetting: 'off' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).toMerge.map(p => p.num), result.stdout).toEqual([7]);
  expect(result.prViews.length).toBeGreaterThan(0);
  for (const { fields, view } of result.prViews) {
    expect(Object.keys(view).every(f => fields.includes(f))).toBe(true);
    expect(view).not.toHaveProperty('rowsComplete');
    expect(view).not.toHaveProperty('rowsHead');
  }
  const endpoints = result.calls.filter(a => a[0] === 'api' && a.includes('--paginate') && a.includes('--slurp')).map(a => a.at(-1));
  expect(endpoints).toContain(`repos/fixture/web-everything/commits/${'7'.padStart(40, '0')}/check-runs?per_page=100&filter=all`);
  expect(endpoints).toContain(`repos/fixture/web-everything/commits/${'7'.padStart(40, '0')}/status?per_page=100`);
});

const passingRun = { id: 1, name: 'test', status: 'completed', conclusion: 'success', head_sha: '7'.padStart(40, '0') };
it.each([
  ['capped check pages', { liveCheckRunPages: [{ total_count: 101, check_runs: [passingRun] }] }],
  ['missing check pages', { liveCheckRunPages: [] }],
  ['unknown check count', { liveCheckRunPages: [{ check_runs: [passingRun] }] }],
  ['unreadable check pages', { liveCheckRunPages: {} }],
  ['missing status pages', { liveStatusPages: [] }],
])('catch-up skips %s despite a green required check and cached completeness', (_name, patch) => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18, workflowEditSetting: 'off',
    livePatches: { 7: { ...patch,
      statusCheckRollup: Array.from({ length: 100 }, (_, i) => ({ __typename: 'CheckRun', name: i ? `check-${i}` : 'test',
        status: 'COMPLETED', conclusion: 'SUCCESS' })), liveCheckRuns: [passingRun] } } });
  expect(result.status, result.stderr).toBe(0);
  const decision = JSON.parse(result.stdout);
  expect(decision.toMerge).toEqual([]);
  expect(decision.skipped.some(p => p.num === 7 && /check evidence incomplete.*complete live check read/.test(p.reason))).toBe(true);
});

it('catch-up discovers failing CodeQL omitted from a capped PR view even when the required check passes', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18, workflowEditSetting: 'off',
    livePatches: { 7: {
      statusCheckRollup: Array.from({ length: 100 }, (_, i) => ({ __typename: 'CheckRun', name: i ? `check-${i}` : 'test',
        status: 'COMPLETED', conclusion: 'SUCCESS' })),
      liveCheckRuns: [passingRun, { ...passingRun, id: 2, name: 'CodeQL', conclusion: 'failure' }],
    } } });
  expect(result.status, result.stderr).toBe(0);
  const decision = JSON.parse(result.stdout);
  expect(decision.toMerge).toEqual([]);
  expect(decision.skipped.some(p => p.num === 7 && /CodeQL/.test(p.reason)), result.stdout).toBe(true);
});

it('a live default-branch change during membership is read afresh, refuses publication and falls back to slow classification', () => {
  const result = runFastDrainContextCli({ catchUp: true, rowCount: 18, branchAfterMembership: 'develop' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.passSnapshotPublished).toBe(false);
  expect(result.fullListings + result.heavyListings).toBeGreaterThan(0);
  expect(result.stderr).toContain('default branch changed during membership — discarded pass snapshot; falling back to live listing');
  expect(result.cachedBranch).toBe('develop');
  expect(result.calls.some(a => a[0] === 'api' && a[1]?.endsWith('/git/ref/heads/develop'))).toBe(true);
  const decision = JSON.parse(result.stdout);
  expect(decision.toMerge).toEqual([]);
  expect(decision.skipped.some(p => p.num === 7 && /base is not develop \(main\)/.test(p.reason))).toBe(true);
});

process.env.WE_UNDER_TEST = '1';
const { readFreshGateChecks, reduceOpenPrContext, prepareDrainVerdicts, planDrainPass, buildOverlapRows, revalidateForMerge } = await import('../merge-ai-prs.mjs');
const { repo, rows } = fixture;
const inventory = prs => ({ rows: prs.map(p => Object.fromEntries(LEAN_OPEN_PR_FIELDS.split(',').map(f => [f, p[f]]))),
  totalCount: prs.length, hasNextPage: false, truncated: false });
const head = { sha: 'a'.repeat(40), defaultBranch: 'main' };

function pass(extra = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'fast-pass-'));
  const options = { path: join(dir, 'round.json'), repos: [repo], targetRepo: repo,
    snapshots: new Map([[repo, rows]]), readMain: async () => head, listLean: async () => inventory(rows),
    now: () => 1000, env: {}, ...extra };
  return { options, close: () => rmSync(dir, { recursive: true, force: true }) };
}

it('three concurrent catch-up drains share one base snapshot and revalidate lean membership per reader', async () => {
  let pages = 0, mains = 0, snapshotReads = 0;
  const f = pass({ readMain: async () => { mains++; return head; },
    readSnapshot: () => { snapshotReads++; return rows; },
    listLean: async () => { pages++; await setImmediate(); return inventory(rows); } });
  try {
    const results = await Promise.all([1, 2, 3].map(() => readFastDrainPassInventory(f.options)));
    expect(pages).toBe(3); // Fresh lean membership for each child; no full-PR pages.
    expect(snapshotReads).toBe(4);
    expect(mains).toBe(9); // Each reader rechecks after membership, and cold waiters also recheck under the lock.
    expect(results.every(r => r.inventories.get(repo).totalCount === 18)).toBe(true);
  } finally { f.close(); }
});

for (const invalid of ['main moved', 'TTL expired', 'future', 'corrupt', 'oversized', 'legacy round']) {
  it(`${invalid} invalidates the pass and publishes new source rows under the lock`, async () => {
    const f = pass();
    try {
      await readFastDrainPassInventory(f.options);
      const replacement = rows.map(p => ({ ...p, body: 'replacement source facts' }));
      let locked = 0;
      const next = { ...f.options, readSnapshot: () => replacement,
        lock: async fn => { locked++; return { ok: true, value: await fn(() => true) }; } };
      if (invalid === 'main moved') next.readMain = async () => ({ ...head, sha: 'b'.repeat(40) });
      if (invalid === 'TTL expired') next.now = () => 61_000;
      if (invalid === 'future') next.now = () => 999;
      if (invalid === 'corrupt') writeFileSync(f.options.path, '{');
      if (invalid === 'oversized') truncateSync(f.options.path, 64 * 1024 * 1024 + 1);
      if (invalid === 'legacy round') writeFileSync(f.options.path, JSON.stringify({ repo, writtenAt: 1000, rows, defaultBranch: 'main' }));
      const result = await readFastDrainPassInventory(next);
      expect(locked).toBe(1);
      expect(result.snapshots.get(repo)).toEqual(replacement);
      expect(JSON.parse(readFileSync(f.options.path, 'utf8')).rows).toEqual(replacement);
    } finally { f.close(); }
  });
}

for (const fence of ['lost', 'missing']) {
  it(`a ${fence} ownership fence refuses publication before a reader can observe it`, async () => {
    let held = true, valueReturned = false;
    const f = pass({ listLean: async () => { held = false; return inventory(rows); },
      lock: async fn => { const value = await fn(fence === 'lost' ? () => held : undefined); valueReturned = true; return { ok: false, value, reason: 'lock-lost' }; } });
    try {
      await expect(readFastDrainPassInventory(f.options)).rejects.toThrow('lock-lost');
      expect(valueReturned).toBe(false);
      expect(existsSync(f.options.path)).toBe(false);
    } finally { f.close(); }
  });
}

for (const ttl of ['2', '120', '0']) {
  it(`pass reuse honours configured snapshot TTL=${ttl}s, including cache disable`, async () => {
    let now = 1000, locks = 0;
    const f = pass({ now: () => now, env: { WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC: ttl },
      lock: async fn => { locks++; return { ok: true, value: await fn(() => true) }; } });
    try {
      if (ttl === '0') {
        await expect(readFastDrainPassInventory(f.options)).rejects.toThrow('snapshot disabled');
        expect(locks).toBe(0);
        expect(existsSync(f.options.path)).toBe(false);
      } else {
        await readFastDrainPassInventory(f.options);
        now += Number(ttl) * 1000 - 1;
        await readFastDrainPassInventory(f.options);
        expect(locks).toBe(1);
        now++;
        await readFastDrainPassInventory(f.options);
        expect(locks).toBe(2);
      }
    } finally { f.close(); }
  });
}

for (const underLock of [false, true]) {
  it(`expiry during awaited membership refuses a ${underLock ? 'locked' : 'direct'} hit`, async () => {
    let now = 1000;
    const f = pass({ now: () => now });
    try {
      await readFastDrainPassInventory(f.options);
      let reads = 0;
      const read = path => { if (underLock && ++reads === 1) throw Error('force lock recheck'); return JSON.parse(readFileSync(path, 'utf8')); };
      await expect(readFastDrainPassInventory({ ...f.options, read,
        listLean: async () => { now += 70_000; return inventory(rows); },
      })).rejects.toThrow('expired while reading');
    } finally { f.close(); }
  });
}

it('expiry during cold membership reads refuses publication', async () => {
  let now = 1000;
  const f = pass({ now: () => now, listLean: async () => { now += 70_000; return inventory(rows); } });
  try {
    await expect(readFastDrainPassInventory(f.options)).rejects.toThrow('expired while reading');
    expect(existsSync(f.options.path)).toBe(false);
  } finally { f.close(); }
});

it('unknown main, incomplete/oversized inventory and lock refusal defer explicitly to the next pass', async () => {
  for (const patch of [
    { readMain: async () => ({ sha: null }) },
    { listLean: async () => ({ ...inventory(rows), totalCount: 19 }) },
    { listLean: async () => ({ ...inventory(rows), hasNextPage: true, truncated: true }) },
    { lock: async () => ({ ok: false, reason: 'round-lock-deadline' }) },
  ]) {
    const f = pass(patch);
    try { await expect(readFastDrainPassInventory(f.options)).rejects.toThrow(); }
    finally { f.close(); }
  }
});

// Use the same reduction, carrier health/join, overlap planner and final head gate as the drain.
async function productionDecision(byRepo, targetRepo, number, fresh, { degraded = false } = {}) {
  const localRepo = [...byRepo.keys()][0];
  const listings = [...byRepo].map(([repo, prs]) => ({ repo, prs: structuredClone(prs) }));
  const reads = new Map(listings.flatMap(({ repo, prs }) => prs.map(p => [`${repo}::${p.number}`,
    { manifest: p.manifest ?? p.recordedManifest, commits: p.commits ?? [], degraded }])));
  const openPrContext = reduceOpenPrContext({ listings, reads });
  const options = { listings, openPrContext, repos: [...byRepo.keys()], onlyPr: String(number), onlyRepo: targetRepo,
    localSlug: localRepo, isLocalRepo: r => r === localRepo, defaultBranchOf: () => 'main', label: 'ready-to-merge',
    readOf: (r, n) => reads.get(`${r}::${n}`) };
  const { verdicts } = prepareDrainVerdicts(options);
  const overlap = buildOverlapRows({ candidates: verdicts, verdicts, openPrContext, localSlug: localRepo });
  const waits = overlapYieldWaits({ candidates: overlap.candidateRows.map(p => ({ ...p, readyAtMs: 1000, windowMs: 60_000 })),
    openPrs: overlap.openPrRows, nowMs: 2000 });
  const { plan, carrierHealth } = planDrainPass({ ...options, verdicts, overlapContext: waits });
  const enqueue = [], refused = [];
  await runEnqueueCandidates(plan.ready, { run: async c => {
    const gate = revalidateForMerge(await fresh(c), { defaultBranch: 'main', expectedHeadSha: c.listedHeadSha });
    if (gate.decision === 'merge') enqueue.push(c.num);
    else refused.push([c.num, gate.reason]);
  } });
  return { enqueue, refused, ready: plan.ready.map(p => p.num),
    skipped: verdicts.filter(p => p.decision !== 'merge').map(p => [p.num, p.reason]),
    deferred: plan.deferred.map(p => [p.num, p.waitOn, p.coupleDeferReason]),
    health: [...carrierHealth], waits: [...waits], complete: openPrContext.contextComplete };
}

for (const [name, recording] of [['frozen', fixture], ['recorded', recorded]]) {
  it(`${name} 18-PR parity uses production reduction, planning and enqueue revalidation with differing live facts`, async () => {
    const { repo: targetRepo, rows: source } = recording;
    expect(source).toHaveLength(18);
    const live = structuredClone(source);
    // A target and every related component must refresh despite identical head/updatedAt.
    const snapshot = source.map(p => ({ ...p, mergeable: 'UNKNOWN', statusCheckRollup: [] }));
    let listings = 0;
    const f = pass({ repos: [targetRepo], targetRepo, readSnapshot: () => snapshot,
      listLean: async () => { listings++; return inventory(live); } });
    try {
      const before = [], after = [];
      for (const p of live) {
        const context = await readFastDrainContext({ repos: [targetRepo], targetRepo, onlyPr: p.number,
          readInventory: () => readFastDrainPassInventory(f.options), failClosed: true,
          readFull: async (_repo, n) => live.find(p => p.number === n),
          readManifest: async (_repo, p) => p.manifest ?? p.recordedManifest });
        const fresh = c => live.find(p => p.number === c.num);
        before.push(await productionDecision(new Map([[targetRepo, live]]), targetRepo, p.number, fresh));
        after.push(await productionDecision(context, targetRepo, p.number, fresh));
      }
      expect(after).toEqual(before);
      expect(before.some(p => p.enqueue.length)).toBe(true);
      expect(before.some(p => p.skipped.length || p.deferred.length)).toBe(true);
      expect(listings).toBe(18);
    } finally { f.close(); }
  });
}

it('listing context reads overlap within the configured bound and preserve the blocked target', async () => {
  let active = 0, peak = 0;
  const context = await readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: 7,
    readSnapshot: () => rows, listLean: async () => inventory(rows), concurrency: 2, failClosed: true,
    readFull: async (_repo, n) => rows.find(p => p.number === n),
    readManifest: async (_repo, p) => { active++; peak = Math.max(peak, active); await setImmediate(); active--; return p.manifest; } });
  expect(peak).toBe(2);
  expect(context.get(repo).find(p => p.number === 8).labels).toContainEqual({ name: 'review:changes' });
});

it('catch-up holds on incomplete context without falling back to full pagination', () => {
  const r = runFastDrainContextCli({ catchUp: true, leanIncomplete: true, rowCount: 18 });
  expect(r.status).not.toBe(0);
  expect(r.fullListings + r.heavyListings).toBe(0);
  expect(r.stderr).toContain('retry next pass');
});

for (const invalid of ['TTL expired', 'dirty', 'disabled']) {
  it(`pass reuse rejects a source snapshot that became ${invalid}, without refreshing it`, async () => {
    const f = pass();
    let now = 20_000, refreshes = 0;
    const env = { WE_PR_SNAPSHOT_DIR: dirname(f.options.path), WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_TTL_MS: '75000' };
    writeFileSync(snapshotPath(env.WE_PR_SNAPSHOT_DIR, repo), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
      repo, prs: rows, fields: SNAPSHOT_FIELDS, fetchedAtMs: 0 }));
    f.options.readSnapshot = r => readSharedOpenPrs({ repo: r, fields: SNAPSHOT_FIELDS, env, now: () => now,
      cacheOnly: true, exec: () => { refreshes++; throw Error('must not refresh'); } });
    try {
      await readFastDrainPassInventory(f.options);
      if (invalid === 'TTL expired') now = 75_000;
      if (invalid === 'dirty') markPrSnapshotDirty({ repo, env, nowMs: now });
      if (invalid === 'disabled') env.WE_PR_SNAPSHOT = '0';
      await expect(readFastDrainPassInventory(f.options)).rejects.toThrow('snapshot unavailable/disabled/stale/dirty');
      expect(refreshes).toBe(0);
    } finally { f.close(); }
  });
}

it('cascade sibling reads run within gateReads, keep result order and join failures before releasing the pool', async () => {
  let active = 0, peak = 0, settled = 0;
  const read = async n => {
    active++; peak = Math.max(peak, active);
    await setImmediate(); active--; settled++;
    if (n === 1) throw Error('unreadable sibling');
    return n;
  };
  await expect(readFastDrainFacts([1, 2, 3, 4], 2, read)).rejects.toThrow('unreadable sibling');
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(settled).toBe(4);
  expect(await readFastDrainFacts([3, 1, 2], 2, async n => { await setImmediate(); return n; })).toEqual([3, 1, 2]);
});

it('cascade check/status reads overlap through the injected client and keep head-bound completeness', async () => {
  let active = 0, peak = 0;
  const calls = [];
  const checks = await readFreshGateChecks({ repo, headSha: head.sha, exec: async (file, argv) => {
    calls.push([file, argv]); active++; peak = Math.max(peak, active); await setImmediate(); active--;
    return { stdout: JSON.stringify([argv.at(-1).includes('/check-runs?')
      ? { total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }
      : { total_count: 0, statuses: [] }]) };
  } });
  expect(peak).toBe(2);
  expect(calls).toHaveLength(2);
  expect(calls.every(([file, argv]) => file === 'gh' && argv.includes('--paginate') && argv.at(-1).includes(head.sha))).toBe(true);
  expect(checks.rowsComplete).toBe(true);
  expect(checks.rowsHead).toBe(head.sha);
});

it('cascade missing status pages never turn a green check-run into complete evidence', async () => {
  const checks = await readFreshGateChecks({ repo, headSha: head.sha, concurrency: 1,
    exec: async (_file, argv) => ({ stdout: JSON.stringify(argv.at(-1).includes('/check-runs?')
      ? [{ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }]
      : []) }) });
  expect(checks.rowsComplete).toBe(false);
  expect(reviewCiGate({ headSha: head.sha, requiredChecks: ['test'], checks,
    rowsComplete: checks.rowsComplete, rowsHead: checks.rowsHead }).allowed).toBe(false);
  await expect(readFreshGateChecks({ repo, headSha: head.sha,
    exec: async () => { throw Error('unreadable GitHub'); } })).rejects.toThrow('unreadable GitHub');
});

it('missing status pages skip real classification and cascade revalidation despite a green check-run', async () => {
  const target = rows[16];
  const complete = await productionDecision(new Map([[repo, [target]]]), repo, target.number, () => target);
  expect(complete.ready).toEqual([target.number]);
  expect(complete.enqueue).toEqual([target.number]);
  const checks = await readFreshGateChecks({ repo, headSha: target.headRefOid,
    exec: async (_file, argv) => ({ stdout: JSON.stringify(argv.at(-1).includes('/check-runs?')
      ? [{ total_count: 1, check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] }]
      : []) }) });
  expect(checks.rowsComplete).toBe(false);
  const incomplete = { ...target, statusCheckRollup: checks, rowsComplete: checks.rowsComplete, rowsHead: checks.rowsHead };
  const classified = await productionDecision(new Map([[repo, [incomplete]]]), repo, target.number, () => incomplete);
  expect(classified.ready).toEqual([]);
  expect(classified.enqueue).toEqual([]);
  expect(classified.skipped).toEqual([[target.number, expect.stringContaining('check evidence incomplete')]]);
  const revalidated = await productionDecision(new Map([[repo, [target]]]), repo, target.number, () => incomplete);
  expect(revalidated.ready).toEqual([target.number]);
  expect(revalidated.enqueue).toEqual([]);
  expect(revalidated.refused).toEqual([[target.number, expect.stringContaining('check evidence incomplete')]]);
});

it('a main move while waiting for the pass lock is rebound before any snapshot is published', async () => {
  let sha = head.sha;
  const f = pass({ readMain: async () => ({ ...head, sha }),
    lock: async fn => { sha = 'b'.repeat(40); return { ok: true, value: await fn(() => true) }; } });
  try {
    await readFastDrainPassInventory(f.options);
    expect(JSON.parse(readFileSync(f.options.path, 'utf8')).heads[repo].sha).toBe(sha);
  } finally { f.close(); }
});

it('main-SHA and minimal inventory reads fan out within gateReads across context repos', async () => {
  let active = 0, peak = 0;
  const bounded = async value => { active++; peak = Math.max(peak, active); await setImmediate(); active--; return value; };
  const repos = [repo, 'fixture/two', 'fixture/three'];
  const f = pass({ repos, concurrency: 2, readSnapshot: () => rows,
    readMain: () => bounded(head), listLean: () => bounded(inventory(rows)) });
  try {
    const result = await readFastDrainPassInventory(f.options);
    expect(peak).toBe(2);
    expect(result.inventories.size).toBe(3);
  } finally { f.close(); }
});

it('a newly opened blocker prevents enqueue during valid pass reuse with unchanged main and TTL', async () => {
  const target = rows[0], blocker = rows[1];
  let live = [target], snapshotReads = 0, membershipReads = 0;
  const fullReads = [];
  const f = pass({ readSnapshot: () => { snapshotReads++; return [target]; },
    listLean: async () => { membershipReads++; return inventory(live); } });
  const context = () => readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: target.number,
    readInventory: () => readFastDrainPassInventory(f.options), failClosed: true,
    readFull: async (_repo, number) => { fullReads.push(number); return live.find(p => p.number === number); },
    readManifest: async (_repo, p) => p.manifest });
  try {
    expect((await productionDecision(await context(), repo, target.number, () => target)).enqueue).toEqual([7]);
    // The same main SHA and clock keep the pass valid; opening this PR does not move main.
    live = [target, blocker];
    const decision = await productionDecision(await context(), repo, target.number, () => target);
    expect(decision.enqueue).toEqual([]);
    expect(decision.deferred.map(([num, waitOn]) => [num, waitOn])).toEqual([[7, [108]]]);
    expect(membershipReads).toBe(2);
    expect(snapshotReads).toBe(3);
    expect(fullReads).toEqual([7, 7, 8]);
  } finally { f.close(); }
});

it('valid pass reuse fails closed when live membership revalidation is unreadable or incomplete', async () => {
  const f = pass();
  try {
    await readFastDrainPassInventory(f.options);
    for (const listLean of [
      async () => { throw Error('membership unreadable'); },
      async () => ({ ...inventory(rows), totalCount: rows.length + 1 }),
    ]) {
      await expect(readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: 7,
        readInventory: () => readFastDrainPassInventory({ ...f.options, listLean }), failClosed: true,
        readFull: async (_repo, number) => rows.find(p => p.number === number), readManifest: async (_repo, p) => p.manifest,
      })).rejects.toThrow(/incomplete pass context.*retry next pass/);
    }
  } finally { f.close(); }
});

for (const conclusion of ['FAILURE', 'SUCCESS']) {
  it(`scope=full reconciles an unrelated same-head PR from live ${conclusion} checks and labels`, () => {
    const result = runFastDrainContextCli({ catchUp: true, scope: 'full', rowCount: 18,
      livePatches: { 8: { mergeable: 'UNKNOWN',
        labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }, ...(conclusion === 'SUCCESS' ? [{ name: 'ci:failed' }] : [])],
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }] } } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.fullListings + result.heavyListings).toBe(0);
    expect(result.calls.some(a => a[0] === 'pr' && a[1] === 'view' && a[2] === '8'
      && a[a.indexOf('--json') + 1].includes('statusCheckRollup'))).toBe(true);
    expect(JSON.parse(result.stdout).reconciledLabels).toContain(8);
  });
}

it('production couple health holds an impl when its same-head carrier gained a live review hold', async () => {
  const implRepo = 'fixture/frontierui';
  const impl = { ...rows[16], manifest: null };
  const carrier = { ...rows[15], manifest: { item: 122, blockedBy: [], stackParents: [],
    repos: [{ repo: 'we', ref: rows[15].headRefName }, { repo: 'fui', ref: impl.headRefName }] } };
  const liveCarrier = { ...carrier, labels: [{ name: 'review:changes' }] };
  const byRepo = new Map([[repo, [liveCarrier]], [implRepo, [impl]]]);
  const context = await readFastDrainContext({ repos: [...byRepo.keys()], targetRepo: implRepo, onlyPr: impl.number,
    readSnapshot: r => r === repo ? [carrier] : [impl], listLean: async r => inventory(byRepo.get(r)), failClosed: true,
    readFull: async (r, n) => byRepo.get(r).find(p => p.number === n), readManifest: async (_r, p) => p.manifest });
  const fresh = () => impl;
  const before = await productionDecision(byRepo, implRepo, impl.number, fresh);
  const after = await productionDecision(context, implRepo, impl.number, fresh);
  expect(after).toEqual(before);
  expect(after.health[0][1].held).toBe(true);
  expect(after.deferred).toHaveLength(1);
  expect(after.enqueue).toEqual([]);
  // A positive control makes the live carrier refresh load-bearing.
  const stale = await productionDecision(new Map([[repo, [carrier]], [implRepo, [impl]]]), implRepo, impl.number, fresh);
  expect(stale.enqueue).toEqual([impl.number]);
});

it('production context reduction refuses absent-carrier proof after a degraded read', async () => {
  const implRepo = 'fixture/frontierui', impl = { ...rows[16], manifest: null };
  const byRepo = new Map([[repo, []], [implRepo, [impl]]]);
  expect((await productionDecision(byRepo, implRepo, impl.number, () => impl)).enqueue).toEqual([impl.number]);
  const incomplete = await productionDecision(byRepo, implRepo, impl.number, () => impl, { degraded: true });
  expect(incomplete.complete).toBe(false);
  expect(incomplete.enqueue).toEqual([]);
  expect(incomplete.deferred).toHaveLength(1);
});

it('production overlap planning refreshes a related same-head red check before choosing enqueue order', async () => {
  const green = rows[16];
  const target = { ...green, number: 100, files: [{ path: 'src/shared.mjs', additions: 1, deletions: 0 }] };
  const partner = { ...rows[15], files: [{ path: 'src/shared.mjs', additions: 100, deletions: 0 }] };
  const redPartner = { ...partner, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  const live = [target, redPartner];
  const context = await readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: target.number,
    readSnapshot: () => [target, partner], listLean: async () => inventory(live), failClosed: true,
    readFull: async (_r, n) => live.find(p => p.number === n), readManifest: async (_r, p) => p.manifest });
  const after = await productionDecision(context, repo, target.number, () => target);
  expect(after).toEqual(await productionDecision(new Map([[repo, live]]), repo, target.number, () => target));
  expect(after.enqueue).toEqual([target.number]);
  const stale = await productionDecision(new Map([[repo, [target, partner]]]), repo, target.number, () => target);
  expect(stale.waits).toHaveLength(1);
  expect(stale.enqueue).toEqual([]);
});

for (const change of ['head', 'CI', 'review hold']) {
  it(`production enqueue revalidation refuses a target whose ${change} changed after planning`, async () => {
    const target = rows[16];
    const context = await readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: target.number,
      readSnapshot: () => [target], listLean: async () => inventory([target]), failClosed: true,
      readFull: async () => target, readManifest: async (_r, p) => p.manifest });
    const fresh = { ...target, ...(change === 'head' ? { headRefOid: 'f'.repeat(40) } : change === 'CI'
      ? { statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }
      : { labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }] }) };
    const result = await productionDecision(context, repo, target.number, () => fresh);
    expect(result.ready).toEqual([target.number]);
    expect(result.enqueue).toEqual([]);
    expect(result.refused).toHaveLength(1);
  });
}

for (const phase of ['cold', 'direct hit', 'locked hit']) {
  for (const invalid of ['expired', 'dirty']) {
    it(`source refresh during ${phase} membership replaces ${invalid} pass rows with fresh cache-only evidence`, async () => {
      const f = pass();
      let now = 20_000, refreshes = 0;
      const env = { WE_PR_SNAPSHOT_DIR: dirname(f.options.path), WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_TTL_MS: '75000' };
      const sourcePath = snapshotPath(env.WE_PR_SNAPSHOT_DIR, repo);
      const publish = (prs, fetchedAtMs) => writeFileSync(sourcePath, JSON.stringify({ v: PR_SNAPSHOT_VERSION,
        repo, prs, fields: SNAPSHOT_FIELDS, fetchedAtMs }));
      publish(rows, 0);
      f.options.readSnapshot = r => readSharedOpenPrs({ repo: r, fields: SNAPSHOT_FIELDS, env, now: () => now,
        cacheOnly: true, exec: () => { refreshes++; throw Error('must not refresh'); } });
      const replacement = rows.map(p => ({ ...p, labels: [{ name: 'review:changes' }],
        statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }));
      try {
        if (phase !== 'cold') await readFastDrainPassInventory(f.options);
        let reads = 0;
        const result = await readFastDrainPassInventory({ ...f.options,
          read: path => { if (phase === 'locked hit' && ++reads === 1) throw Error('force locked hit'); return JSON.parse(readFileSync(path, 'utf8')); },
          listLean: async () => {
            await setImmediate();
            if (invalid === 'expired') now = 75_000;
            else markPrSnapshotDirty({ repo, env, nowMs: now });
            expect(f.options.readSnapshot(repo)).toBeNull(); // The old source no longer passes cacheOnly validation.
            publish(replacement, ++now);
            return inventory(rows); // Identical head/updatedAt cannot make the pass's old checks reusable.
          },
        });
        const freshRows = f.options.readSnapshot(repo);
        expect(freshRows).not.toBeNull();
        expect(result.snapshots.get(repo)).toEqual(freshRows);
        expect(result.snapshots.get(repo)[0].statusCheckRollup[0].conclusion).toBe('FAILURE');
        if (phase === 'cold') expect(JSON.parse(readFileSync(f.options.path, 'utf8')).rows).toEqual(freshRows);
        expect(refreshes).toBe(0);
      } finally { f.close(); }
    });
  }

  it(`main moving during ${phase} membership discards the snapshot and falls back to live listing`, async () => {
    const sibling = 'fixture/sibling';
    let siblingHead = head;
    const f = pass({ repos: [repo, sibling], readSnapshot: () => rows,
      readMain: async r => r === sibling ? siblingHead : head });
    try {
      if (phase !== 'cold') await readFastDrainPassInventory(f.options);
      const before = phase === 'cold' ? null : readFileSync(f.options.path, 'utf8');
      let reads = 0, writes = 0, membershipFinished = false;
      const logs = [];
      const result = await readFastDrainContext({ repos: f.options.repos, targetRepo: repo, onlyPr: 7,
        readInventory: () => readFastDrainPassInventory({ ...f.options,
          read: path => { if (phase === 'locked hit' && ++reads === 1) throw Error('force locked hit'); return JSON.parse(readFileSync(path, 'utf8')); },
          write: () => { writes++; },
          listLean: async () => {
            await setImmediate();
            siblingHead = { ...head, sha: 'b'.repeat(40) };
            membershipFinished = true;
            return inventory(rows);
          },
        }),
        readFull: async (_repo, number) => rows.find(p => p.number === number),
        readManifest: async (_repo, p) => p.manifest,
        log: line => logs.push(line),
      });
      expect(membershipFinished).toBe(true);
      expect(result).toBeNull(); // The caller selects its slow live-listing path on null.
      expect(logs).toEqual([expect.stringContaining('context fell back to full listing (pass main changed while reading')]);
      expect(writes).toBe(0);
      if (phase === 'cold') expect(existsSync(f.options.path)).toBe(false);
      else expect(readFileSync(f.options.path, 'utf8')).toBe(before);
    } finally { f.close(); }
  });

  for (const invalid of ['expired', 'dirty']) {
    it(`source snapshot becoming ${invalid} during ${phase} membership reads defers without publication`, async () => {
      const f = pass();
      let now = 20_000;
      const env = { WE_PR_SNAPSHOT_DIR: dirname(f.options.path), WE_PR_SNAPSHOT: '1', WE_PR_SNAPSHOT_TTL_MS: '75000' };
      writeFileSync(snapshotPath(env.WE_PR_SNAPSHOT_DIR, repo), JSON.stringify({ v: PR_SNAPSHOT_VERSION,
        repo, prs: rows, fields: SNAPSHOT_FIELDS, fetchedAtMs: 0 }));
      f.options.readSnapshot = r => readSharedOpenPrs({ repo: r, fields: SNAPSHOT_FIELDS, env, now: () => now, cacheOnly: true,
        exec: () => { throw Error('cache-only source must never refresh'); } });
      try {
        if (phase !== 'cold') await readFastDrainPassInventory(f.options);
        let reads = 0, writes = 0;
        await expect(readFastDrainPassInventory({ ...f.options,
          read: path => { if (phase === 'locked hit' && ++reads === 1) throw Error('force locked hit'); return JSON.parse(readFileSync(path, 'utf8')); },
          write: () => { writes++; },
          listLean: async () => {
            if (invalid === 'expired') now = 75_000;
            else markPrSnapshotDirty({ repo, env, nowMs: now });
            return inventory(rows);
          },
        })).rejects.toThrow('snapshot unavailable/disabled/stale/dirty');
        expect(writes).toBe(0);
      } finally { f.close(); }
    });
  }
}

for (const number of [7, 8]) {
  it(`full scope resolves capped live checks for ${number === 7 ? 'the target gate' : 'unrelated lifecycle reconciliation'}`, () => {
    const sha = number.toString(16).padStart(40, '0');
    const result = runFastDrainContextCli({ catchUp: true, scope: 'full', rowCount: 18,
      livePatches: { [number]: {
        statusCheckRollup: Array.from({ length: 100 }, (_, i) => ({ __typename: 'CheckRun', name: i ? `check-${i}` : 'test',
          status: 'COMPLETED', conclusion: 'SUCCESS' })),
        liveCheckRuns: [{ id: 12345, name: 'test', status: 'completed', conclusion: 'failure', head_sha: sha }],
      } } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.some(a => a[0] === 'api' && a[1]?.includes(`${sha}/check-runs?`)
      && a.includes('--paginate') && a.includes('--slurp'))).toBe(true);
    const decision = JSON.parse(result.stdout);
    expect(decision.reconciledLabels).toContain(number);
    if (number === 7) {
      expect(decision.toMerge).toEqual([]);
      expect(decision.skipped.some(p => p.num === 7 && /required check/.test(p.reason))).toBe(true);
    }
  });
}

describe('stale cache-only snapshot on the first catch-up child (drain-fastdrain-crash)', () => {
  it('builds the round by refreshing a stale source snapshot once, then serves the rest from the round', async () => {
    const f = pass();
    let refreshes = 0;
    const options = { ...f.options, readSnapshot: () => null,
      refreshSnapshot: () => { refreshes++; return rows; } };
    try {
      const first = await readFastDrainPassInventory(options);
      expect(first.snapshots.get(repo)).toEqual(rows);
      expect(refreshes).toBe(2); // the source read and the post-membership re-read, both while building the round
      // A later child with a stale source must NOT refresh while reusing the published round.
      await expect(readFastDrainPassInventory({ ...options, refreshSnapshot: () => { refreshes++; return rows; } })).rejects.toThrow('snapshot unavailable/disabled/stale/dirty');
      expect(refreshes).toBe(2);
    } finally { f.close(); }
  });

  it('a refresh slower than the pass TTL still builds a round (bound starts after it); membership read after the bound still fails closed', async () => {
    const f = pass();
    let t = 1000;
    const slow = { ...f.options, now: () => t, readSnapshot: () => null, refreshSnapshot: () => { if (t === 1000) t += 90_000; return rows; } };
    try {
      await expect(readFastDrainPassInventory(slow)).resolves.toBeTruthy();
      const late = pass();
      let u = 1000;
      await expect(readFastDrainPassInventory({ ...late.options, now: () => u, readSnapshot: () => null, refreshSnapshot: () => rows,
        listLean: async () => { u += 90_000; return inventory(rows); } })).rejects.toThrow('expired while reading');
      late.close();
    } finally { f.close(); }
  });

  for (const bad of ['null', 'throws', 'not-array']) {
    it(`stays fail-closed and publishes no round when the refresh is ${bad}`, async () => {
      const f = pass();
      const refreshSnapshot = () => { if (bad === 'throws') throw new Error('pr list unreadable'); return bad === 'null' ? null : {}; };
      try {
        await expect(readFastDrainPassInventory({ ...f.options, readSnapshot: () => null, refreshSnapshot })).rejects.toThrow(/snapshot unavailable|pr list unreadable/);
        expect(existsSync(f.options.path)).toBe(false);
      } finally { f.close(); }
    });
  }

  it('classifies the incomplete pass context failure instead of "unknown"', () => {
    expect(classifyChildFailure('merge-ai-prs Error: fast-drain: incomplete pass context (snapshot unavailable/disabled/stale/dirty) — retry next pass'))
      .toBe('incomplete-context');
    expect(classifyChildFailure('something else entirely')).toBe('unknown');
  });
});
