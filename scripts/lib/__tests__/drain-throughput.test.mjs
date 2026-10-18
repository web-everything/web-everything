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

describe('drain throughput', () => {
  it('defaults on, supports rollback and reports each source', () => {
    const log = vi.fn();
    expect(resolveDrainThroughput({ file: {}, platform: {}, env: {}, log }).value).toEqual({ holdFirst: true, catchUpSkipUnchangedHolds: true, carryOverReadyFirst: true, catchUpSkipMaxMin: 15 });
    const out = resolveDrainThroughput({ file: { drain: { holdFirst: false } }, platform: {}, env: {}, log });
    expect(out.value.holdFirst).toBe(false);
    expect(out.sources.holdFirst).toBe('tool');
    expect(log).toHaveBeenCalled();
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
  it('catch-up sees a sibling opened after the snapshot and yields to it', async () => {
    const src = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    const listing = src.slice(src.indexOf('  const listOne = async (repo) => {'), src.indexOf('  const resolveDefaultBranch = async (repo) => {'));
    const target = { number: 1, state: 'OPEN', baseRefName: 'main', headRefOid: 'a', files: [{ path: 'shared', additions: 1 }], labels: [] };
    const sibling = { number: 2, baseRefName: 'main', headRefOid: 'b', files: [{ path: 'shared', additions: 100 }], labels: ['review:pending'] };
    const live = vi.fn(() => ({ rows: [target, sibling], truncated: false, cache: {} }));
    const context = {
      process: { env: { WE_DRAIN_CATCH_UP_SNAPSHOT: '1' }, stderr: { write() {} } },
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
