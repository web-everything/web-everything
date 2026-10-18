// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDrainThroughput, createHoldMemo, holdSignature, unchangedHold, orderCarry, carryReady, readCarry, writeCarry } from '../drain-throughput.mjs';
import { EventEmitter } from 'node:events';
import { createEnqueueOnEvent } from '../enqueue-on-event.mjs';
import { createDrainMergeStrategy } from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { buildSkipReasons } from '../drain-skip-reasons.mjs';

describe('drain throughput', () => {
  it('defaults on, supports rollback and reports each source', () => {
    const log = vi.fn();
    expect(resolveDrainThroughput({ file: {}, platform: {}, env: {}, log }).value).toEqual({ holdFirst: true, catchUpSkipUnchangedHolds: true, carryOverReadyFirst: true });
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
    const prev = { kind: 'red-team-pending', signature: holdSignature(pr, { recorded: false }) };
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
    expect(src).toContain('listed = { rows: snapshotSeed');
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
