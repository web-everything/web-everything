import { mkdtempSync, rmSync, writeFileSync, readFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { readFastDrainContext, readFastDrainPassInventory, LEAN_OPEN_PR_FIELDS, readFastDrainFacts } from '../lib/fast-drain-context.mjs';
import { reviewCiGate } from '../lib/review-ci-gate.mjs';
import fixture from './fixtures/fast-drain-18-prs.json';
import recorded from './fixtures/fast-drain-18-prs.recorded.json';
import { it, expect } from 'vitest';
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

process.env.WE_UNDER_TEST = '1';
const { classifyPr, planLabelDrain, readFreshGateChecks } = await import('../merge-ai-prs.mjs');
const { repo, rows } = fixture;
const inventory = prs => ({ rows: prs.map(p => Object.fromEntries(LEAN_OPEN_PR_FIELDS.split(',').map(f => [f, p[f]]))),
  totalCount: prs.length, hasNextPage: false, truncated: false });
const head = { sha: 'a'.repeat(40), defaultBranch: 'main' };

function pass(extra = {}) {
  const dir = mkdtempSync(join(process.env.TMPDIR, 'fast-pass-'));
  const options = { path: join(dir, 'round.json'), repos: [repo], targetRepo: repo,
    snapshots: new Map([[repo, rows]]), readMain: async () => head, listLean: async () => inventory(rows),
    now: () => 1000, ...extra };
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
    expect(snapshotReads).toBe(1);
    expect(mains).toBe(6); // Each cold waiter also rechecks after acquiring the pass lock.
    expect(results.every(r => r.inventories.get(repo).totalCount === 18)).toBe(true);
  } finally { f.close(); }
});

for (const invalid of ['main moved', 'TTL expired', 'future', 'corrupt', 'oversized', 'legacy round']) {
  it(`fails closed on ${invalid}: stale inventory cannot hide a newly opened blocker`, async () => {
    const f = pass();
    try {
      await readFastDrainPassInventory(f.options);
      const next = { ...f.options, listLean: async () => { throw Error('fresh inventory unreadable'); } };
      if (invalid === 'main moved') next.readMain = async () => ({ ...head, sha: 'b'.repeat(40) });
      if (invalid === 'TTL expired') next.now = () => 61_000;
      if (invalid === 'future') next.now = () => 999;
      if (invalid === 'corrupt') writeFileSync(f.options.path, '{');
      if (invalid === 'oversized') truncateSync(f.options.path, 64 * 1024 * 1024 + 1);
      if (invalid === 'legacy round') writeFileSync(f.options.path, JSON.stringify({ repo, writtenAt: 1000, rows, defaultBranch: 'main' }));
      await expect(readFastDrainPassInventory(next)).rejects.toThrow('fresh inventory unreadable');
    } finally { f.close(); }
  });
}

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

it('18-PR frozen fixture: full listing and narrowed reads have identical enqueue/skip and blocker decisions', async () => {
  expect(rows).toHaveLength(18);
  const decisions = (prs, onlyPr) => {
    const p = prs.find(p => p.number === onlyPr);
    const gate = classifyPr(p, { defaultBranch: 'main' });
    if (gate.decision !== 'merge') return { enqueue: [], skip: [[onlyPr, gate.reason]] };
    const m = p.manifest;
    const plan = planLabelDrain([{ num: onlyPr, repo, headSha: p.headRefOid, ...gate,
      item: m.item, blockedBy: m.blockedBy, stackParents: m.stackParents, hasManifest: true }],
    { extraOpenItems: prs.map(p => p.manifest.item), contextComplete: true, isWeRepo: () => true });
    return { enqueue: plan.ready.map(p => p.num), skip: plan.deferred.map(p => [p.num, p.waitOn]) };
  };
  const f = pass();
  try {
    let reads = 0;
    const before = [], after = [];
    for (const target of rows) {
      const context = await readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: target.number,
        readSnapshot: () => rows, readInventory: () => readFastDrainPassInventory(f.options),
        listLean: () => { throw Error('unshared listing'); }, failClosed: true,
        readFull: async (_repo, n) => { reads++; return rows.find(p => p.number === n); },
        readManifest: async (_repo, p) => p.manifest });
      before.push(decisions(rows, target.number));
      after.push(decisions(context.get(repo), target.number));
    }
    expect(after).toEqual(before);
    expect(before.some(p => p.enqueue.length)).toBe(true);
    expect(before.some(p => p.skip.length)).toBe(true);
    expect(before[0]).toEqual({ enqueue: [], skip: [[7, [108]]] });
    expect(reads).toBeLessThan(18 * 18);
  } finally { f.close(); }
});

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

it('a published pass remains usable when a sibling enqueue dirties the host cache', async () => {
  let snapshotReads = 0;
  const f = pass({ readSnapshot: () => { if (++snapshotReads > 1) throw Error('host cache dirty'); return rows; } });
  try {
    await readFastDrainPassInventory(f.options);
    const shared = await readFastDrainPassInventory(f.options);
    expect(shared.snapshots.get(repo)).toEqual(rows);
    expect(snapshotReads).toBe(1);
  } finally { f.close(); }
});

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

it('a main move while waiting for the pass lock is rebound before any snapshot is published', async () => {
  let sha = head.sha;
  const f = pass({ readMain: async () => ({ ...head, sha }),
    lock: async fn => { sha = 'b'.repeat(40); return { ok: true, value: await fn() }; } });
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

it('recorded 18 real PRs: before/after enqueue and skip decisions are identical', async () => {
  const { repo, rows } = recorded;
  expect(rows).toHaveLength(18);
  let listings = 0, snapshotReads = 0;
  const f = pass({ repos: [repo], targetRepo: repo,
    readSnapshot: () => { snapshotReads++; return rows; },
    listLean: async () => { listings++; return inventory(rows); } });
  const decide = (prs, number) => {
    const p = prs.find(p => p.number === number);
    const gate = classifyPr(p, { defaultBranch: 'main' });
    if (gate.decision !== 'merge') return { enqueue: [], skip: [[number, gate.reason]] };
    const m = p.recordedManifest;
    const plan = planLabelDrain([{ ...gate, repo, num: number, headSha: p.headRefOid,
      item: m?.item, blockedBy: m?.blockedBy ?? [], stackParents: m?.stackParents ?? [], hasManifest: !!m }],
    { extraOpenItems: prs.map(p => p.recordedManifest?.item).filter(Boolean), contextComplete: true, isWeRepo: () => true });
    return { enqueue: plan.ready.map(p => p.num), skip: plan.deferred.map(p => [p.num, p.waitOn]) };
  };
  try {
    const before = [], after = [];
    for (const p of rows) {
      const context = await readFastDrainContext({ repos: [repo], targetRepo: repo, onlyPr: p.number,
        readInventory: () => readFastDrainPassInventory(f.options), failClosed: true,
        readFull: async (_repo, number) => rows.find(p => p.number === number),
        readManifest: async (_repo, p) => p.recordedManifest });
      before.push(decide(rows, p.number));
      after.push(decide(context.get(repo), p.number));
    }
    expect(after).toEqual(before);
    expect(listings).toBe(rows.length);
    expect(snapshotReads).toBe(1);
    expect(before.some(d => d.enqueue.length > 0)).toBe(true);
    expect(before.some(d => d.skip.length > 0)).toBe(true);
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
  const decide = prs => planLabelDrain([{ num: target.number, repo, decision: 'merge',
    item: target.manifest.item, blockedBy: target.manifest.blockedBy, hasManifest: true }],
  { extraOpenItems: prs.map(p => p.manifest.item), contextComplete: true, isWeRepo: () => true });
  try {
    expect(decide((await context()).get(repo)).ready.map(p => p.num)).toEqual([7]);
    // The same main SHA and clock keep the pass valid; opening this PR does not move main.
    live = [target, blocker];
    const plan = decide((await context()).get(repo));
    expect(plan.ready).toEqual([]);
    expect(plan.deferred.map(p => [p.num, p.waitOn])).toEqual([[7, [108]]]);
    expect(membershipReads).toBe(2);
    expect(snapshotReads).toBe(1);
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
