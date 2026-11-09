import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createEnqueueOnEvent, planCatchUp, CATCH_UP_DECLINE_TTL_MS, readCatchUpCandidates } from '../enqueue-on-event.mjs';

const now = 10_000_000;
const labelsDigest = createHash('sha256').update(JSON.stringify(['ready-to-merge'])).digest('hex');
const pr = (num = 42, extra = {}) => ({ num, readyAt: num, baseRefName: 'main',
  labels: [{ name: 'ready-to-merge' }], headRefOid: 'head-a', labelsDigest,
  lastCheckCompletedAt: now - 120_000, lastLabelChangedAt: now - 180_000, checksDigest: 'checks-a', ...extra });
const decline = (extra = {}) => ({ headSha: 'head-a', reason: 'mq-same-head-failed',
  labelsDigest, checksDigest: 'checks-a', mainCiRunId: 100, at: now - 60_000, ...extra });
const plan = (extra = {}) => planCatchUp({ prs: [pr()], queued: 0, capacity: 10,
  now, mainCiRunId: 100, declines: new Map([[42, decline()]]), ...extra });

describe('catch-up decline memory', () => {
  it('skips an unchanged same-head same-reason decline without mutating memory', () => {
    const declines = new Map([[42, decline()]]);
    expect(plan({ declines })).toMatchObject({ run: [], skippedUnchanged: [{ num: 42, reason: 'mq-same-head-failed' }] });
    expect(declines.get(42)).toEqual(decline());
  });
  it.each([
    ['new head', { headRefOid: 'head-b' }],
    ['completed check on this head after decline', { lastCheckCompletedAt: now - 1 }],
    ['completed suite changing', { checksDigest: 'checks-b' }],
    ['label digest change', { labelsDigest: 'labels-b' }],
    ['label removed and restored', { lastLabelChangedAt: now - 1 }],
  ])('re-checks on %s', (_name, extra) => expect(plan({ prs: [pr(42, extra)] }).run).toHaveLength(1));
  it('expires at 60 minutes, including the exact boundary', () => {
    expect(CATCH_UP_DECLINE_TTL_MS).toBe(60 * 60_000);
    const oldChecks = [pr(42, { lastCheckCompletedAt: now - 2 * 60 * 60_000, lastLabelChangedAt: now - 2 * 60 * 60_000 })];
    expect(plan({ prs: oldChecks, declines: new Map([[42, decline({ at: now - 60 * 60_000 })]]) }).run).toHaveLength(1);
    expect(plan({ prs: oldChecks, declines: new Map([[42, decline({ at: now - 60 * 60_000 + 1 })]]) }).run).toHaveLength(0);
  });
  it('re-checks when label-change evidence is missing (fail open)', () => {
    const missing = pr(42); delete missing.lastLabelChangedAt;
    expect(plan({ prs: [missing] }).run).toHaveLength(1);
  });
  it('an expired decline no longer demotes priority', () => {
    const fresh = [pr(1), pr(2)];
    const declines = new Map([[1, decline({ at: now - 31 * 60_000, ttlMs: 30 * 60_000 })]]);
    expect(plan({ prs: fresh, declines }).run.map(p => p.num)).toEqual([1, 2]);
  });
  it('re-checks when main CI newest completed run changes', () => expect(plan({ mainCiRunId: 101 }).run).toHaveLength(1));
  it.each([undefined, null, {}, 'bad json', new Map([[42, {}]])])('unreadable memory fails open (%s)', declines => {
    expect(plan({ declines }).run).toHaveLength(1);
  });
  it.each(['headRefOid', 'labelsDigest', 'lastCheckCompletedAt', 'checksDigest'])('missing %s evidence fails open', field => {
    expect(plan({ prs: [pr(42, { [field]: null })] }).run).toHaveLength(1);
  });
  it('missing main CI evidence fails open', () => expect(plan({ mainCiRunId: null }).run).toHaveLength(1));
  it('puts no-hold PRs first, retaining existing order in each partition', () => {
    const result = plan({ prs: [pr(4), pr(3), pr(2), pr(1)], mainCiRunId: 101,
      declines: new Map([[1, decline()], [3, decline()]]), capacity: 2, deprioritize: [2] });
    expect(result.run.map(p => p.num)).toEqual([4, 2]);
    expect(result.later).toEqual([1, 3]);
  });
});

function daemon({ result, evidence = {}, catchUp = {}, code = { v: 'a'.repeat(40) } } = {}) {
  let time = now; let calls = 0;
  const lines = [];
  const handle = createEnqueueOnEvent({ cwd: '.', localSlug: 'example/web', defaultBranch: 'main', env: {},
    now: () => time, log: line => lines.push(line), refreshPending: () => ({ pending: false }),
    readPendingChange: () => ({ ok: true, paths: [] }), readPriorities: () => ({}),
    resolveSetting: () => ({ enabled: true, debounceSeconds: 15, catchUp: { enabled: true, intervalMinutes: 10, concurrency: 1, maxQueued: 10, ...catchUp } }),
    readCandidates: async () => ({ ok: true, queued: 0, prs: [pr(42, evidence)], mainCiRunId: 100 }),
    readCapacity: () => ({ capacity: 10, source: 'test' }), readQueueDepth: async () => ({ ok: true, queued: 0 }),
    readPr: async () => ({ ...pr(), state: 'OPEN', statusCheckRollup: [] }), readCodeVersion: () => code.v,
    spawnImpl: () => {
      calls++;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      queueMicrotask(() => { child.stdout.emit('data', JSON.stringify(result || { considered: 1, toMerge: [],
        skipReasons: [{ num: 42, reason: 'checks failing' }] })); child.emit('close', 0); });
      return child;
    },
  });
  return { code, handle, lines, calls: () => calls, advance: () => { time += 600_000; } };
}

it('records actual declines and prints skipped-unchanged: #n (reason) in the listing log', async () => {
  const d = daemon({ result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'mq-same-head-failed', reason: 'same head failed' }] } });
  await d.handle.catchUp(); d.advance(); await d.handle.catchUp();
  expect(d.calls()).toBe(1);
  expect(d.lines.find(line => line.includes('skipped-unchanged:'))).toContain('skipped-unchanged: #42 (mq-same-head-failed)');
});

it.each(['batching-deferred', 'merge-lock-held', 'live-state-unreadable', 'some-future-kind'])('retries %s next catch-up with unchanged head, labels, checks and main CI', async (kind) => {
  const d = daemon({ evidence: { lastLabelChangedAt: now - 180_000 },
    result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind,
      reason: 'transient' }] } });
  expect(await d.handle.catchUp()).toMatchObject([{ num: 42, outcome: 'not-enqueued' }]);
  expect(d.calls()).toBe(1);
  d.advance();
  expect(await d.handle.catchUp()).toMatchObject([{ num: 42, outcome: 'not-enqueued' }]);
  expect(d.calls()).toBe(2);
  expect(d.handle.blocked().size).toBe(0);
  expect(d.handle.missBackoff().size).toBe(0);
  expect(d.lines.some(line => line.includes('skipped-unchanged:'))).toBe(false);
});

it.each(['checks unreadable for this head', 'unknown reason', 'same head failed but evidence incomplete'])('does not remember an mq-same-head-failed with partial evidence (%s)', async (reason) => {
  const d = daemon({ result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'mq-same-head-failed', reason }] } });
  await d.handle.catchUp(); d.advance(); await d.handle.catchUp();
  expect(d.calls()).toBe(2);
  expect(d.lines.some(line => line.includes('skipped-unchanged:'))).toBe(false);
});

it('dedupe never outlives the configured miss-backoff ttl or blocked rounds', () => {
  const oldPr = [pr(42, { lastCheckCompletedAt: now - 2 * 60 * 60_000, lastLabelChangedAt: now - 2 * 60 * 60_000 })];
  expect(plan({ prs: oldPr, declines: new Map([[42, decline({ at: now - 31 * 60_000, ttlMs: 30 * 60_000 })]]) }).run).toHaveLength(1);
  expect(plan({ prs: oldPr, declines: new Map([[42, decline({ at: now - 29 * 60_000, ttlMs: 30 * 60_000 })]]) }).run).toHaveLength(0);
});

it.each([{ blockedBackoffRounds: 0 }, { missBackoff: { enabled: false, ttlMinutes: 30 } }])('dedupe is off when the existing bound is disabled (%o)', async (catchUp) => {
  const d = daemon({ catchUp, result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'mq-same-head-failed', reason: 'same head failed' }] } });
  await d.handle.catchUp(); d.advance(); await d.handle.catchUp();
  expect(d.calls()).toBe(2);
  expect(d.lines.some(line => line.includes('skipped-unchanged:'))).toBe(false);
});

it.each([['changes', 'b'.repeat(40)], ['is unreadable', null]])('a drain code version that %s drops the remembered decline', async (_n, next) => {
  const d = daemon({ result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued', kind: 'mq-same-head-failed', reason: 'same head failed' }] } });
  await d.handle.catchUp(); d.advance(); d.code.v = next; await d.handle.catchUp();
  expect(d.lines.some(line => line.includes('skipped-unchanged:'))).toBe(false);
});

it('a daemon restart fails open and re-checks everything', async () => {
  const first = daemon(); await first.handle.catchUp();
  const restarted = daemon(); await restarted.handle.catchUp();
  expect(restarted.calls()).toBe(1);
});

it('a new completed check clears an existing same-head wake backoff', async () => {
  const evidence = {};
  const d = daemon({ evidence, result: { enqueueOutcomes: [{ num: 42, outcome: 'not-enqueued',
    kind: 'mq-same-head-failed', reason: 'same head previously failed required checks' }] } });
  await d.handle.catchUp();
  d.advance(); evidence.lastCheckCompletedAt = now + 1;
  await d.handle.catchUp();
  expect(d.calls()).toBe(2);
});

describe('batched listing change evidence', () => {
  const connection = nodes => ({ nodes, pageInfo: { hasNextPage: false } });
  const checks = (conclusion = 'SUCCESS') => connection([{ id: 'suite', status: 'COMPLETED', conclusion, checkRuns: connection([
    { id: 'run', status: 'COMPLETED', conclusion, completedAt: new Date(now - 120_000).toISOString() },
  ]) }]);
  async function listing({ incompleteChecks = false, incompleteRuns = false, incompleteMain = false, partialMain = false, wrongHead = false, failedBatch = false, missingStatus = false, partialStatus = false, statusState = 'SUCCESS', conclusion = 'SUCCESS', noConclusion = false } = {}) {
    let calls = 0;
    const result = await readCatchUpCandidates({ repo: 'example/web', readComments: () => [],
      execFileImpl: (_cmd, args, _opts, cb) => {
        calls++;
        const suites = checks(noConclusion ? null : conclusion); suites.pageInfo.hasNextPage = incompleteChecks;
        suites.nodes[0].checkRuns.pageInfo.hasNextPage = incompleteRuns;
        const main = connection([{ status: 'COMPLETED', workflowRun: { databaseId: 100, workflow: { name: 'CI' } } },
          { status: 'IN_PROGRESS', workflowRun: { databaseId: 101, workflow: { name: 'CI' } } },
          { status: 'COMPLETED', workflowRun: { databaseId: 102, workflow: { name: 'Other' } } }]);
        main.pageInfo.hasNextPage = incompleteMain;
        if (partialMain) main.nodes.push({ status: 'COMPLETED', workflowRun: { databaseId: 99, workflow: null } });
        const repository = calls === 1 ? {
          pullRequests: connection([{ number: 42, ...pr(), labels: connection(pr().labels) }]),
          mergeQueue: { entries: { totalCount: 0 } },
        } : {
          mainCi: { target: { checkSuites: main } },
          p42: { headRefOid: 'head-a', commits: { nodes: [{ commit: { oid: wrongHead ? 'old-head' : 'head-a', checkSuites: suites,
            ...(partialStatus ? { status: {} } : missingStatus ? {} : { status: { contexts: [{ context: 'legacy/ci', state: statusState, createdAt: new Date(now - 130_000).toISOString() }] } }) } }] },
            timelineItems: { nodes: [
              { __typename: 'LabeledEvent', label: { name: 'ready-to-merge' }, createdAt: new Date(now - 180_000).toISOString() },
              { __typename: 'UnlabeledEvent', label: { name: 'other' }, createdAt: new Date(now - 1).toISOString() },
            ] } },
        };
        if (calls === 2 && failedBatch) return cb(new Error('unreadable'));
        cb(null, JSON.stringify({ data: { repository } }));
        if (calls === 2) {
          expect(args.join(' ')).toContain('checkSuites(first:20)');
          expect(args.join(' ')).toContain('UNLABELED_EVENT');
        }
      },
    });
    expect(calls).toBe(2); // no additional per-PR evidence calls
    return result;
  }
  it('reads head, label, completed check and newest completed main CI facts in the existing batch', async () => {
    const result = await listing();
    expect(result.mainCiRunId).toBe(100);
    expect(result.prs[0]).toMatchObject({ headRefOid: 'head-a', labelsDigest,
      lastCheckCompletedAt: now - 120_000, lastLabelChangedAt: now - 1,
      checksDigest: expect.any(String), readyAt: now - 180_000 });
  });
  it.each([
    { incompleteChecks: true }, { missingStatus: true }, { partialStatus: true }, { statusState: 'FAILURE' }, { conclusion: 'FAILURE' }, { noConclusion: true }, { incompleteRuns: true }, { incompleteMain: true }, { partialMain: true }, { wrongHead: true }, { failedBatch: true },
  ])('fails open on incomplete or unreadable evidence %j', async options => {
    const baseline = await listing();
    const complete = baseline.prs[0];
    const declines = new Map([[complete.num, decline({
      headSha: complete.headRefOid, labelsDigest: complete.labelsDigest,
      checksDigest: complete.checksDigest, mainCiRunId: baseline.mainCiRunId, at: now,
    })]]);
    expect(plan({ ...baseline, declines })).toMatchObject({
      run: [], skippedUnchanged: [{ num: 42, reason: 'mq-same-head-failed' }],
    });
    const result = await listing(options);
    expect(plan({ ...result, mainCiRunId: result.mainCiRunId, declines })).toMatchObject({ run: [{ num: 42 }], skippedUnchanged: [] });
  });
});
