// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDrainThroughput, createHoldMemo, holdSignature, unchangedHold, orderCarry, carryReady, readCarry, writeCarry } from '../drain-throughput.mjs';
import { runInNewContext } from 'node:vm';
import { buildOverlapRows, planLabelDrain } from '../../merge-ai-prs.mjs';
import { overlapYieldWaits } from '../../conveyor/land-overlap-yield.mjs';
import { EventEmitter } from 'node:events';
import { createEnqueueOnEvent } from '../enqueue-on-event.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { buildSkipReasons } from '../drain-skip-reasons.mjs';
import { ROUND_SNAPSHOT_ENV, readRoundSnapshot, writeRoundSnapshot } from '../drain-round-snapshot.mjs';

describe('drain throughput', () => {
  it('defaults on, supports rollback and reports each source', () => {
    const log = vi.fn();
    expect(resolveDrainThroughput({ file: {}, platform: {}, env: {}, log }).value).toEqual({ redMainSkipCatchUp: true, holdFirst: true, overlapFirst: true, priorityReservesFiles: true, catchUpSkipQueueOverlap: true, catchUpSkipUnchangedHolds: true, carryOverReadyFirst: true, catchUpSkipMaxMin: 15, priorityReserveMaxMin: 90 });
    const out = resolveDrainThroughput({ file: { drain: { holdFirst: false } }, platform: {}, env: {}, log });
    expect(out.value.holdFirst).toBe(false);
    expect(out.sources.holdFirst).toBe('tool');
    expect(log.mock.calls.flat().join(' ')).toContain('redMainSkipCatchUp=true (default)');
  });
  it('cascades the red-team priority reservation deadline and reports its source', () => {
    const log = vi.fn();
    const resolve = (drain = {}, platform = {}) => resolveDrainThroughput({ file: { drain }, platform, env: {}, log });
    expect(resolve().value.priorityReserveMaxMin).toBe(90);
    expect(resolve().sources.priorityReserveMaxMin).toBe('standard');
    expect(resolve({ priorityReserveMaxMin: 20 }).value.priorityReserveMaxMin).toBe(20);
    expect(resolve({ priorityReserveMaxMin: 20 }).sources.priorityReserveMaxMin).toBe('tool');
    expect(resolve({}, { priorityReserveMaxMin: 30 }).value.priorityReserveMaxMin).toBe(30);
    expect(resolve({}, { priorityReserveMaxMin: 30 }).sources.priorityReserveMaxMin).toBe('platform');
    expect(resolve({ priorityReserveMaxMin: 0 }).value.priorityReserveMaxMin).toBe(0);
    for (const value of [-1, Infinity, NaN, '90'])
      expect(resolve({ priorityReserveMaxMin: value }).value.priorityReserveMaxMin).toBe(90);
    expect(log.mock.calls.flat().join(' ')).toContain('priorityReserveMaxMin=90 (standard)');
  });
  it.each([
    ['priorityReservesFiles', 'WE_DRAIN_PRIORITY_RESERVES_FILES'],
    ['overlapFirst', 'WE_DRAIN_OVERLAP_FIRST'],
    ['catchUpSkipQueueOverlap', 'WE_DRAIN_CATCH_UP_SKIP_QUEUE_OVERLAP'],
  ])('validates overrides and logs sources for %s', (key, envKey) => {
    const log = vi.fn();
    const resolve = (file = {}, env = {}) => resolveDrainThroughput({ file: { drain: file }, platform: {}, env, log });
    expect(resolve().value[key]).toBe(true);
    expect(resolve().sources[key]).toBe('default');
    expect(resolve({ [key]: false }).value[key]).toBe(false);
    expect(resolve({ [key]: false }).sources[key]).toBe('tool');
    expect(resolve({ [key]: 'false' }).value[key]).toBe(true);
    expect(resolve({}, { [envKey]: 'off' }).value[key]).toBe(false);
    expect(resolve({}, { [envKey]: 'off' }).sources[key]).toBe('env');
    expect(resolve({ [key]: false }, { [envKey]: 'on' }).value[key]).toBe(true);
    const invalid = resolve({ [key]: false }, { [envKey]: 'invalid' });
    expect(invalid.value[key]).toBe(false);
    expect(invalid.sources[key]).toBe('tool');
    expect(invalid.invalid).toEqual(expect.arrayContaining([expect.stringContaining(`env.${key}`)]));
    expect(log.mock.calls.flat().join(' ')).toContain(`${key}=true (default)`);
  });
  it('evaluates holds once per repo, PR and head; disabled calls every time', async () => {
    const evaluate = vi.fn(() => ({ kind: 'red-team-pending' }));
    const held = createHoldMemo(true);
    const c = { repo: 'o/r', num: 1, headSha: 'a' };
    await held(c, evaluate); await held(c, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(1);
    await held({ ...c, headSha: 'b' }, evaluate);
    await held({ ...c, repo: 'o/s' }, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(3);
    const off = createHoldMemo(false);
    await off(c, evaluate); await off(c, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(5);
  });
  it('only remembers holds, so cleared candidates still get live gates', async () => {
    const evaluate = vi.fn(() => null), memo = createHoldMemo(true);
    await memo({ num: 1 }, evaluate); await memo({ num: 1 }, evaluate);
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it('reports enqueue holds honestly and excludes enqueued PRs from pass-end leftovers', () => {
    const verdicts = [1,2,3,4,5].map(num => ({ num, decision: 'merge' }));
    const rows = buildSkipReasons({ verdicts, enqueueOutcomes: [
      { num: 1, outcome: 'not-enqueued', kind: 'red-team-pending', reason: 'waiting' },
      { num: 2, outcome: 'not-enqueued', kind: 'merge-lock-held', reason: 'busy' },
      { num: 3, outcome: 'not-enqueued', kind: 'branch-preparation', reason: 'branch numbering refused' },
      { num: 4, outcome: 'enqueued' },
    ] });
    expect(rows.map(x => x.kind)).toEqual(['red-team-pending','merge-lock-held','numbering','ready-not-reached']);
    expect(rows.at(-1).reason).not.toMatch(/cap|budget|dependency/);
    expect(carryReady(rows)).toEqual([{ num: 5, repo: null }]);
    expect(buildSkipReasons({ verdicts, passEnded: false })).toEqual([]);
  });
  it('invalidates a catch-up hold on head, labels or red-team evidence changes', () => {
    const pr = { headRefOid: 'a', labels: [{ name: 'ready-to-merge' }], comments: [{ body: 'old' }] };
    const prev = { kind: 'red-team-pending', recordedAt: Date.now(), signature: holdSignature(pr, { recorded: false }) };
    expect(unchangedHold(prev, pr, { recorded: false })).toBe(true);
    expect(unchangedHold(prev, { ...pr, headRefOid: 'b' }, { recorded: false })).toBe(false);
    expect(unchangedHold(prev, { ...pr, labels: [] }, { recorded: false })).toBe(false);
    expect(unchangedHold(prev, pr, { recorded: true })).toBe(false);
    expect(unchangedHold({ ...prev, kind: 'ready-not-reached' }, pr, { recorded: false })).toBe(false);
    expect(unchangedHold(prev, null, {})).toBe(false);
  });
  it('persists only true pass-end leftovers and orders eligible candidates without changing membership', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drain-carry-'));
    try {
      const path = join(dir, 'carry.json');
      expect(readCarry(path)).toEqual([]);
      writeCarry(path, [{ num: 2, repo: 'o/r' }]);
      const rows = [{ num: 1, repo: 'o/r' }, { num: 2, repo: 'o/r' }, { num: 2, repo: 'o/s' }];
      expect(orderCarry(rows, readCarry(path))).toEqual([rows[1], rows[0], rows[2]]);
      expect(orderCarry(rows, readCarry(path), false)).toEqual(rows);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('wires early holds before sibling reads and revalidation, and reuses the shared listing', () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const cascade = src.slice(src.indexOf('const __mergeCascadeT0'));
    expect(cascade.indexOf('earlyHold(c)')).toBeGreaterThan(0);
    expect(cascade.indexOf('earlyHold(c)')).toBeLessThan(cascade.indexOf('await revalidateFresh('));
    expect(src).toMatch(/buildSkipReasons\(\{[^\n]*enqueueOutcomes/);
    expect(src.includes('listed = { rows: snapshotSeed')).toBe(false);
  });
  it('earlyHold stamps and requests a local priority head before returning its recorded red-team hold', async () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    // earlyHold is the memoised single definition `preEnqueueHold` (card-group admission reuses it).
    expect(src).toContain('const earlyHold = c => memoHold(c, () => preEnqueueHold(c));');
    const start = src.indexOf('  const preEnqueueHold = async');
    const end = src.indexOf('  // xym8nt4 — card-group admission', start);
    const hold = { kind: 'red-team-pending', deferred: true };
    const order = [];
    const strategy = {
      priorityReserveStamp: vi.fn(() => order.push('stamp')),
      requestRedTeamWhileDeferred: vi.fn(() => order.push('request')),
      priorityReserveHold: () => null,
      recordedHold: () => { order.push('hold'); return hold; },
    };
    const earlyHold = runInNewContext(`${src.slice(start, end)}; preEnqueueHold`, {
      preparedPass: { plan: { deferred: [] } },
      localSlug: 'o/r', escalationRelief: {}, hasUnclearedReviewLabel: () => false, numberingWithdrawalOwed: () => false,
      throughput: { value: { overlapFirst: false } }, isLocalRepo: () => true,
      isPriorityLabels: labels => labels.includes('priority:now'), mergeStrategy: strategy,
    });
    const c = { num: 42, prLabels: ['priority:now', 'review:accepted', 'ready-to-merge'], listedHeadSha: 'current', headSha: 'old' };
    expect(await earlyHold(c)).toEqual(hold);
    expect(order).toEqual(['stamp', 'request', 'hold']);
    expect(strategy.priorityReserveStamp).toHaveBeenCalledWith(c, 'current');
    expect(strategy.requestRedTeamWhileDeferred).toHaveBeenCalledWith(c, 'current');
    // forGroup: the same safety hold, without the side-effect stamp/request.
    order.length = 0;
    expect(await earlyHold(c, { forGroup: true })).toEqual(hold);
    expect(order).toEqual(['hold']);
  });
  it.each([
    ['fresh round seed is reused', 10_000, false],
    ['stale round seed is ignored and rewritten', 500_000, true],
  ])('catch-up round snapshot: %s; target and open set are still read live', async (_name, ageMs, sharedRead) => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const listing = src.slice(src.indexOf('  const listOne = async (repo) => {'), src.indexOf('  const resolveDefaultBranch = async (repo) => {'));
    const dir = mkdtempSync(join(tmpdir(), 'round-snap-'));
    const path = join(dir, 'o_r-1-r1.json');
    const stale = { number: 1, state: 'OPEN', headRefOid: 'old', labels: [], files: [] };
    const target = { number: 1, state: 'OPEN', headRefOid: 'live', labels: [{ name: 'ready-to-merge' }], files: [] };
    writeRoundSnapshot({ path, repo: 'o/r', fields: 'number,files,updatedAt', rows: [stale], now: Date.now() - ageMs });
    const shared = vi.fn(() => [stale]);
    const targetRead = vi.fn(async () => ({ stdout: JSON.stringify(target) }));
    const live = vi.fn(({ seed }) => ({ rows: seed, truncated: false, cache: {} }));
    const context = {
      process: { env: { WE_DRAIN_CATCH_UP_SNAPSHOT: '1', WE_DRAIN_ROUND_SNAPSHOT: path }, stderr: { write() {} } },
      ROUND_SNAPSHOT_ENV, readRoundSnapshot, writeRoundSnapshot, readRoundSnapshotSetting: () => ({ maxAgeSec: 120, source: 'test' }),
      localSlug: 'o/r', onlyPr: 1, fastDrainListing: { listing: 'snapshot' }, isFastDrainTarget: () => true,
      RECONCILE: true, SWEEP_LIST_FIELDS: 'number,files', workflowEditSetting: { value: 'off' },
      __t: { time: (_, f) => f(), timeAsync: (_, f) => f() },
      readSharedOpenPrs: shared, execFileP: targetRead,
      mergeLiveTargetIntoRows: (snap, row) => [...snap.filter(r => r.number !== row.number), row], resolvePrListPaging: () => ({}),
      listOpenPrsPagedHydrated: live, execFileSyncThrottled() {}, operatorSelects: () => true,
      drainHeavyCacheByRepo: new Map(), passPrState: new Map(), OPEN_PR_LIST_LIMIT: 500,
      resolveListedChecks: async (_, rows) => rows, isDegradedOpenPrListing: () => false,
      describeGhListError: e => String(e),
    };
    try {
      const result = await runInNewContext(`(async () => { ${listing}; return listOne(null); })()`, context);
      expect(result.err).toBeUndefined();
      expect(shared).toHaveBeenCalledTimes(sharedRead ? 1 : 0);
      expect(targetRead).toHaveBeenCalledTimes(1); // the target is always re-read live
      expect(live).toHaveBeenCalledTimes(1); // the live open set is always listed
      expect(result.rows.find(r => r.number === 1).headRefOid).toBe('live');
      if (sharedRead) expect(readRoundSnapshot({ path, repo: 'o/r', fields: 'number', maxAgeSec: 120 }).rows).toEqual([stale]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('catch-up sees a sibling opened after the snapshot and yields to it', async () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const listing = src.slice(src.indexOf('  const listOne = async (repo) => {'), src.indexOf('  const resolveDefaultBranch = async (repo) => {'));
    const target = { number: 1, state: 'OPEN', baseRefName: 'main', headRefOid: 'a', files: [{ path: 'shared', additions: 1 }], labels: [] };
    const sibling = { number: 2, baseRefName: 'main', headRefOid: 'b', files: [{ path: 'shared', additions: 100 }], labels: ['review:pending', 'ready-to-merge'], statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
    const live = vi.fn(() => ({ rows: [target, sibling], truncated: false, cache: {} }));
    const context = {
      process: { env: { WE_DRAIN_CATCH_UP_SNAPSHOT: '1' }, stderr: { write() {} } }, ROUND_SNAPSHOT_ENV,
      localSlug: 'o/r', onlyPr: 1, fastDrainListing: { listing: 'snapshot' }, isFastDrainTarget: () => true,
      RECONCILE: true, SWEEP_LIST_FIELDS: 'number,files', workflowEditSetting: { value: 'off' },
      throughput: { value: { catchUpSkipUnchangedHolds: true } },
      __t: { time: (_, f) => f(), timeAsync: (_, f) => f() },
      readSharedOpenPrs: () => [target], execFileP: async () => ({ stdout: JSON.stringify(target) }),
      mergeLiveTargetIntoRows: (snap, row) => [row], resolvePrListPaging: () => ({}),
      listOpenPrsPagedHydrated: live, execFileSyncThrottled() {}, operatorSelects: () => true,
      drainHeavyCacheByRepo: new Map(), passPrState: new Map(), OPEN_PR_LIST_LIMIT: 500,
      resolveListedChecks: async (_, rows) => rows, isDegradedOpenPrListing: () => false,
      describeGhListError: e => String(e),
    };
    const result = await runInNewContext(`(async () => { ${listing}; return listOne(null); })()`, context);
    expect(result.err).toBeUndefined();
    expect(live).toHaveBeenCalledTimes(1);
    const candidate = { num: 1, repo: 'o/r', decision: 'merge', blockedBy: [] };
    const rows = buildOverlapRows({ candidates: [candidate], verdicts: [candidate], localSlug: 'o/r', openPrContext: { prsByRepo: new Map([[null, result.rows]]) } });
    const waits = overlapYieldWaits({ candidates: rows.candidateRows.map(r => ({ ...r, readyAtMs: 1000, windowMs: 60_000 })), openPrs: rows.openPrRows, nowMs: 1000 });
    expect(planLabelDrain([candidate], { overlapContext: waits }).deferred[0]?.overlapYield?.pr).toBe(2);
  });
  it.each([true, false])('catch-up respects its hold setting (%s) and wakes on new evidence', async enabled => {
    let time = 1000, evidence = { recorded: false };
    const pr = { state: 'OPEN', headRefOid: 'a'.repeat(40), labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [] };
    const spawnImpl = vi.fn((command, args, options) => {
      expect(options.env.WE_DRAIN_CATCH_UP_SNAPSHOT).toBe(enabled ? '1' : undefined);
      if (enabled) expect(options.env.WE_DRAIN_ROUND_SNAPSHOT).toMatch(/catch-up-rounds\/o_r-\d+-r\d+\.json$/);
      else expect(options.env.WE_DRAIN_ROUND_SNAPSHOT).toBeUndefined();
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ considered: 1, enqueueOutcomes: [{ num: 1, outcome: 'not-enqueued', kind: 'red-team-pending', reason: 'waiting' }] }));
        child.emit('close', 0);
      });
      return child;
    });
    const handle = createEnqueueOnEvent({ cwd: process.cwd(), localSlug: 'o/r', env: {}, now: () => time, log: () => {}, spawnImpl,
      resolveThroughput: () => ({ value: { catchUpSkipUnchangedHolds: enabled } }),
      resolveSetting: () => ({ enabled: true, debounceSeconds: 0, catchUp: { enabled: true, intervalMinutes: 1, concurrency: 2, maxQueued: 3 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [{ num: 1, inQueue: false, isDraft: false }] }),
      readCapacity: () => ({ capacity: 3, source: 'test' }), readPriorities: () => ({}),
      readPr: async () => pr, readHoldEvidence: () => evidence,
      readQueueDepth: async () => ({ ok: true, queued: 0, queuedNums: [] }),
    });
    try {
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(1);
      time += 600_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(enabled ? 1 : 2);
      evidence = { recorded: true };
      time += 600_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(enabled ? 2 : 3);
      pr.headRefOid = 'b'.repeat(40); time += 600_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(enabled ? 3 : 4);
    } finally { handle.kill(); }
  });
  it.each(['deadline', 'merged', 'head', 'numbering', 'ttl', 'read-failure'])('ends an unchanged catch-up skip on %s', async change => {
    let time = 1000, owed = true, fail = false;
    const sibling = { state: 'OPEN', headRefOid: 'sibling-a', labels: [] };
    const pr = { state: 'OPEN', headRefOid: 'a'.repeat(40), labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [] };
    const kind = change === 'numbering' ? 'numbering' : 'overlap-yield';
    const overlapYield = { pr: 2, repo: 'o/r', untilMs: time + (change === 'ttl' ? 600_000 : 180_000) };
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ considered: 1, enqueueOutcomes: [{ num: 1, outcome: 'not-enqueued', kind, overlapYield }] }));
        child.emit('close', 0);
      });
      return child;
    });
    const handle = createEnqueueOnEvent({ cwd: process.cwd(), localSlug: 'o/r', env: {}, now: () => time, log: () => {}, spawnImpl,
      resolveThroughput: () => ({ value: { catchUpSkipUnchangedHolds: true, catchUpSkipMaxMin: 5 } }),
      resolveSetting: () => ({ enabled: true, debounceSeconds: 0, catchUp: { enabled: true, intervalMinutes: 1, concurrency: 2, maxQueued: 3 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [{ num: 1, inQueue: false, isDraft: false }] }),
      readCapacity: () => ({ capacity: 3, source: 'test' }), readPriorities: () => ({}),
      readPr: async ({ num }) => { if (fail && num === 2) throw Error('read failed'); return num === 2 ? sibling : pr; },
      readHoldEvidence: () => { if (fail) throw Error('read failed'); return { recorded: false }; },
      readNumberingOwed: () => owed,
      readQueueDepth: async () => ({ ok: true, queued: 0, queuedNums: [] }),
    });
    try {
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(1);
      time += 60_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(1);
      if (change === 'deadline') time = overlapYield.untilMs;
      if (change === 'merged') sibling.state = 'MERGED';
      if (change === 'head') sibling.headRefOid = 'sibling-b';
      if (change === 'numbering') owed = false;
      if (change === 'ttl') time = 301_000;
      if (change === 'read-failure') fail = true;
      time += 60_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(2);
    } finally { handle.kill(); }
  });
  it.each(['retry-rewrite', 'firstPendingAt', 'requestAttemptedAt', 'unattempted-retry-deadline', 'pending-deadline', 'request-deadline', 'unreadable', 'invalid-deadline', 'enqueue-retry', 'unattempted-child-deadline'])('honors catch-up deadlines for durable red-team scheduling: %s', async change => {
    let time = 1_000;
    const head = 'a'.repeat(40);
    const pending = { headSha: head, retryAt: 601_000, firstPendingAt: 1_000, requestAttemptedAt: 1_000 };
    const state = { redTeamPending: { 'cwd#1': pending } };
    if (['unattempted-retry-deadline', 'unattempted-child-deadline', 'invalid-deadline'].includes(change)) delete pending.requestAttemptedAt;
    if (change === 'unattempted-retry-deadline') pending.retryAt = 121_000;
    if (change === 'unattempted-child-deadline') pending.retryAt = 41_000;
    if (change === 'pending-deadline') pending.requestedAt = 1_000;
    const pr = { state: 'OPEN', headRefOid: head, labels: [{ name: 'ready-to-merge' }], statusCheckRollup: [] };
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
      queueMicrotask(() => {
        if (change === 'unattempted-child-deadline') pending.retryAt = 121_000;
        child.stdout.emit('data', JSON.stringify({ considered: 1, enqueueOutcomes: [{ num: 1, outcome: 'not-enqueued', kind: 'red-team-pending' }] }));
        child.emit('close', 0);
      });
      return child;
    });
    const handle = createEnqueueOnEvent({ cwd: process.cwd(), localSlug: 'o/r', env: {}, now: () => time, log: () => {}, spawnImpl,
      resolveThroughput: () => ({ value: { catchUpSkipUnchangedHolds: true, catchUpSkipMaxMin: 15 } }),
      resolveSetting: () => ({ enabled: true, debounceSeconds: 0, catchUp: { enabled: true, intervalMinutes: 1, concurrency: 2, maxQueued: 3 } }),
      readCandidates: async () => ({ ok: true, queued: 0, prs: [{ num: 1, inQueue: false, isDraft: false }] }),
      readCapacity: () => ({ capacity: 3 }), readPriorities: () => ({}), readPr: async () => pr,
      readHoldEvidence: () => ({ recorded: false }), readHoldQueueState: () => state,
      resolveQueueSafety: () => ({ value: { redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3 } }),
      readQueueDepth: async () => ({ ok: true, queued: 0, queuedNums: [] }),
    });
    try {
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(1);
      time = 61_000;
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(1);
      if (change === 'retry-rewrite') { pending.retryAt += 1; pending.checkedAt = time; }
      if (['firstPendingAt', 'requestAttemptedAt'].includes(change)) pending[change] += 1;
      if (change === 'unattempted-retry-deadline') time = pending.retryAt;
      if (change === 'pending-deadline') time = 241_000;
      if (change === 'request-deadline') time = 181_000;
      if (change === 'enqueue-retry') state.enqueueFailures = { 'o/r#1': { headSha: head, retryAt: 121_000 } };
      if (change === 'unreadable') state.unreadable = true;
      if (change === 'invalid-deadline') pending.retryAt = 'unknown';
      time = Math.max(time, 121_000);
      await handle.catchUp(); expect(spawnImpl).toHaveBeenCalledTimes(change === 'retry-rewrite' ? 1 : 2);
    } finally { handle.kill(); }
  });
  it.each([
    { retryAt: 101_000, firstPendingAt: 1_000, due: 101_000 },
    { retryAt: 101_000, firstPendingAt: 1_000, requestedAt: 1_000, due: 241_000 },
    { retryAt: 1_000, firstPendingAt: 1_000, requestedAt: 1_000, due: 241_000 },
    { retryAt: 101_000, firstPendingAt: 1_000, requestAttemptedAt: 1_000, due: 181_000 },
    { retryAt: 1_000, firstPendingAt: 1_000, requestAttemptedAt: 1_000, due: 181_000 },
  ])('ends the memo at the earliest scheduling deadline: $due', ({ due, ...pending }) => {
    const pr = { headRefOid: 'a', labels: [] };
    const evidence = { scheduling: { redTeamPending: { headSha: 'a', ...pending }, redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3 } };
    const previous = { kind: 'red-team-pending', recordedAt: 1_000, signature: holdSignature(pr, evidence) };
    expect(unchangedHold(previous, pr, evidence, { now: due - 1 })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: due })).toBe(false);
  });

  it.each(['shared', 'local'])('ends the memo at an unspent pending deadline (%s)', location => {
    const pr = { headRefOid: 'a', labels: [] };
    const redTeamPending = { headSha: 'a', firstPendingAt: 1_000, checkedAt: 200_000, requestedAt: 1_000, retryAt: 101_000 };
    const evidence = { scheduling: { redTeamPendingMaxMin: 4,
      ...(location === 'shared' ? { redTeamPending } : { local: { redTeamPending } }) } };
    const previous = { kind: 'red-team-pending', recordedAt: 200_000, signature: holdSignature(pr, evidence) };
    expect(unchangedHold(previous, pr, evidence, { now: 240_999 })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: 241_000 })).toBe(false);
  });

  it.each(['shared', 'local'])('preserves TTL after an old pending deadline is spent (%s)', location => {
    const pr = { headRefOid: 'a', labels: [] };
    const now = 3 * 24 * 60 * 60_000;
    const redTeamPending = { headSha: 'a', firstPendingAt: 1_000, checkedAt: 242_000,
      requestedAt: 1_000, retryAt: 101_000 };
    const evidence = { scheduling: { redTeamPendingMaxMin: 4,
      ...(location === 'shared' ? { redTeamPending } : { local: { redTeamPending } }) } };
    const previous = { kind: 'red-team-pending', recordedAt: now, signature: holdSignature(pr, evidence) };
    expect(unchangedHold(previous, pr, evidence, { now: now + 60_000 })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: now + 15 * 60_000 })).toBe(false);
  });

  it.each(['shared', 'local'])('reruns a never-attempted request with passed retryAt after the pending deadline is spent (%s)', location => {
    const pr = { headRefOid: 'a', labels: [] };
    const now = 3 * 24 * 60 * 60_000;
    const redTeamPending = { headSha: 'a', firstPendingAt: 1_000, checkedAt: 242_000, retryAt: now + 1_000 };
    const evidence = { scheduling: { redTeamPendingMaxMin: 4,
      ...(location === 'shared' ? { redTeamPending } : { local: { redTeamPending } }) } };
    const previous = { kind: 'red-team-pending', recordedAt: now, signature: holdSignature(pr, evidence) };
    expect(unchangedHold(previous, pr, evidence, { now })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: now + 1_000 })).toBe(false);
  });

  it.each(['requestedAt', 'requestAttemptedAt'])('requires finite retryAt after %s while allowing a stale finite retryAt', field => {
    const pr = { headRefOid: 'a', labels: [] };
    for (const location of ['shared', 'local']) {
      const redTeamPending = { headSha: 'a', firstPendingAt: 1_000, [field]: 1_000, retryAt: 1_000 };
      const evidence = { scheduling: { redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3,
        ...(location === 'shared' ? { redTeamPending } : { local: { redTeamPending } }) } };
      const previous = { kind: 'red-team-pending', recordedAt: 1_000, signature: holdSignature(pr, evidence) };
      expect(unchangedHold(previous, pr, evidence, { now: 61_000 })).toBe(true);
      for (const retryAt of [NaN, Infinity, undefined, 'x']) {
        redTeamPending.retryAt = retryAt;
        expect(unchangedHold(previous, pr, evidence, { now: 61_000 })).toBe(false);
      }
    }
  });

  it.each(['requestedAt', 'requestAttemptedAt'])('reruns on invalid %s even with a recorded request', field => {
    const pr = { headRefOid: 'a', labels: [] };
    for (const location of ['shared', 'local']) {
      for (const value of [NaN, Infinity, 'x']) {
        const redTeamPending = { headSha: 'a', firstPendingAt: 1_000, requestedAt: 1_000,
          requestAttemptedAt: 1_000, retryAt: 101_000, [field]: value };
        const evidence = { scheduling: { redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3,
          ...(location === 'shared' ? { redTeamPending } : { local: { redTeamPending } }) } };
        const previous = { kind: 'red-team-pending', recordedAt: 1_000, signature: holdSignature(pr, evidence) };
        expect(unchangedHold(previous, pr, evidence, { now: 61_000 })).toBe(false);
      }
    }
  });

  it.each(['requestedAt', 'requestAttemptedAt'])('ignores retryAt and checkedAt rewrites after %s without mutating evidence', field => {
    const pr = { headRefOid: 'a', labels: [] };
    const pending = { headSha: 'a', retryAt: 101_000, checkedAt: 1_000, firstPendingAt: 1_000,
      [field]: 1_000, observation: 'pending', commentCount: 2, reason: 'waiting' };
    const evidence = { scheduling: { redTeamPending: { ...pending }, local: { redTeamPending: { ...pending } },
      enqueueFailure: { headSha: 'a', retryAt: 301_000 }, redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3 } };
    const original = structuredClone(evidence);
    const signature = holdSignature(pr, evidence);
    expect(evidence).toEqual(original);
    const previous = { kind: 'red-team-pending', recordedAt: 1_000, signature };
    for (const entry of [evidence.scheduling, evidence.scheduling.local]) {
      entry.redTeamPending.retryAt = 121_000;
      entry.redTeamPending.checkedAt = 61_000;
    }
    const rewritten = structuredClone(evidence);
    expect(holdSignature(pr, evidence)).toBe(signature);
    expect(unchangedHold(previous, pr, evidence, { now: 150_000 })).toBe(true);
    expect(evidence).toEqual(rewritten);
    const due = field === 'requestedAt' ? 241_000 : 181_000;
    expect(unchangedHold(previous, pr, evidence, { now: due - 1 })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: due })).toBe(false);
    for (const location of ['shared', 'local']) {
      for (const key of ['headSha', 'firstPendingAt', 'requestedAt', 'requestAttemptedAt', 'observation', 'commentCount', 'reason']) {
        const changed = structuredClone(evidence);
        const entry = location === 'shared' ? changed.scheduling : changed.scheduling.local;
        entry.redTeamPending[key] = 'changed';
        expect(holdSignature(pr, changed)).not.toBe(signature);
      }
      const changed = structuredClone(evidence);
      const entry = location === 'shared' ? changed.scheduling : changed.scheduling.local;
      entry.enqueueFailure = { headSha: 'a', retryAt: 302_000 };
      expect(holdSignature(pr, changed)).not.toBe(signature);
    }
  });

  it.each([
    { pending: { headSha: 'b' } },
    { pending: { firstPendingAt: NaN } },
    { policy: { redTeamPendingMaxMin: Infinity } },
    { policy: { redTeamPendingMaxMin: 0 } },
    { pending: { requestedAt: null, requestAttemptedAt: NaN } },
    { pending: { requestedAt: null, requestAttemptedAt: 1_000 }, policy: { redTeamRequestCooldownMin: NaN } },
    { pending: { requestedAt: null, requestAttemptedAt: 1_000 }, policy: { redTeamRequestCooldownMin: 0 } },
    { pending: { requestedAt: null, requestAttemptedAt: null, retryAt: undefined } },
    { pending: { requestedAt: null, requestAttemptedAt: null, retryAt: 'unknown' } },
  ])('reruns on invalid pending scheduling evidence: %j', ({ pending, policy }) => {
    const pr = { headRefOid: 'a', labels: [] };
    const scheduling = { redTeamPending: { headSha: 'a', firstPendingAt: 1_000, requestedAt: 1_000, retryAt: 101_000, ...pending },
      redTeamPendingMaxMin: 4, redTeamRequestCooldownMin: 3, ...policy };
    for (const evidence of [{ scheduling }, { scheduling: { ...scheduling, redTeamPending: undefined, local: { redTeamPending: scheduling.redTeamPending } } }]) {
      const previous = { kind: 'red-team-pending', recordedAt: 1_000, signature: holdSignature(pr, evidence) };
      expect(unchangedHold(previous, pr, evidence, { now: 61_000 })).toBe(false);
    }
  });

  it('bounds all holds by the earliest enqueue retry, TTL and overlap deadline', () => {
    const pr = { headRefOid: 'a', labels: [] };
    const evidence = { scheduling: { enqueueFailure: { headSha: 'a', retryAt: 201_000 } },
      overlap: { untilMs: 301_000, state: 'OPEN', head: 'b' } };
    const previous = { kind: 'overlap-yield', recordedAt: 1_000, signature: holdSignature(pr, evidence) };
    expect(unchangedHold(previous, pr, evidence, { now: 200_999 })).toBe(true);
    expect(unchangedHold(previous, pr, evidence, { now: 201_000 })).toBe(false);
    expect(unchangedHold(previous, pr, evidence, { now: 61_000, maxMin: 1 })).toBe(false);
    evidence.overlap.untilMs = 101_000;
    previous.signature = holdSignature(pr, evidence);
    expect(unchangedHold(previous, pr, evidence, { now: 101_000 })).toBe(false);
  });

  it('validates the skip TTL and logs its winning source', () => {
    const log = vi.fn();
    const out = resolveDrainThroughput({ file: { drain: { catchUpSkipMaxMin: 2 } }, platform: {}, env: {}, log });
    expect(out.value.catchUpSkipMaxMin).toBe(2);
    expect(out.sources.catchUpSkipMaxMin).toBe('tool');
    expect(log.mock.calls.flat().join(' ')).toContain('catchUpSkipMaxMin');
    expect(resolveDrainThroughput({ file: { drain: { catchUpSkipMaxMin: -1 } }, platform: {}, env: {}, log }).value.catchUpSkipMaxMin).toBe(15);
  });

  it('early recorded holds reuse admission but can never reach a queue mutation', () => {
    const head = 'a'.repeat(40), repo = 'o/r';
    const exec = vi.fn((file, args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head, labels: ['ready-to-merge', 'review:pending'] });
      throw Error('unexpected IO');
    });
    const strategy = createDrainMergeStrategy({ localSlug: repo, isLocalRepo: () => true,
      statePath: 'unused-test-state', dryRun: false,
      resolved: { policy: resolveMergeDeliveryPolicy({ tool: { strategy: 'github-merge-queue' } }) },
      queueSafety: { value: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: false } },
      log: { write: () => {} }, exec,
      readFile: () => JSON.stringify({ pending: [], followedUp: [], redTeamPending: { [`${repo}#1`]: { headSha: head } } }),
    });
    expect(strategy.recordedHold({ repo, num: 1 }, 'b'.repeat(40))).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(strategy.recordedHold({ repo, num: 1 }, head)).toMatchObject({ kind: 'sent-back' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

});

it('cascades redMainSkipCatchUp and logs its source', () => {
  const log = vi.fn();
  const out = resolveDrainThroughput({ file: { drain: { redMainSkipCatchUp: false } }, platform: { redMainSkipCatchUp: true }, env: {}, log });
  expect(out.value.redMainSkipCatchUp).toBe(false);
  expect(out.sources.redMainSkipCatchUp).toBe('tool');
  expect(log.mock.calls.flat().join(' ')).toContain('redMainSkipCatchUp=false (tool)');
});
