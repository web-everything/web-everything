// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapWithConcurrency, runEnqueueCandidates, canParallelEnqueue, createBranchPreparationRequired, shouldPrepareBranchBeforeEnqueue, formatConcurrencySources } from '../drain-concurrency.mjs';
import { decideHoldApprovedHumanSurfaceHead } from '../approved-human-surface-hold.mjs';
import { hashBacklogFiles } from '../queue-branch-numbering.mjs';
import { fetchPrReadsCached, classifyPr } from '../../merge-ai-prs.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

const pause = () => new Promise(resolve => setTimeout(resolve, 5));

describe('bounded drain concurrency', () => {
  it.each([
    [true, true, true], [true, false, false], [false, true, false], [false, false, false],
    [undefined, true, false], [true, undefined, false], ['required', 'queue', true],
  ])('prepares only when required=%s and enqueues=%s (returns %s)', (required, enqueues, expected) => {
    expect(shouldPrepareBranchBeforeEnqueue({ required, enqueues })).toBe(expected);
  });

  it('prepares #6003 with a pending hash card even when its approved human-only head is held', () => {
    const c = { num: 6003, repo: 'owner/repo', headSha: 'a'.repeat(40) };
    const files = ['.github/workflows/ci.yml', 'backlog/xh6zcov-card.md'];
    const required = createBranchPreparationRequired({ enabled: true, readFiles: () => files,
      hasPendingCards: files => hashBacklogFiles(files).length > 0 });
    const approvedHeadHold = decideHoldApprovedHumanSurfaceHead({ setting: 'on', approved: true,
      humanSurface: true, conflicting: false, manifestOnHead: false });
    expect(approvedHeadHold.hold).toBe(true);
    expect(required(c)).toBe(true);
    expect(shouldPrepareBranchBeforeEnqueue({ required: required(c), enqueues: true })).toBe(true);
  });

  it('preserves map order despite out-of-order completion', async () => {
    expect(await mapWithConcurrency([3, 2, 1], 3, async n => {
      await new Promise(resolve => setTimeout(resolve, n)); return n;
    })).toEqual([3, 2, 1]);
  });

  it('only bypasses numbering preparation for a proven hash-free pinned tree', () => {
    let reads = 0;
    const options = { enabled: true, readFiles: c => {
      reads++;
      if (c.repo === 'missing') throw new Error('missing object');
      return c.repo === 'pending' ? ['hash'] : [];
    }, hasPendingCards: files => files.length > 0 };
    const required = createBranchPreparationRequired(options);
    const headSha = 'a'.repeat(40);
    expect(required({ repo: 'clean', headSha })).toBe(false);
    expect(required({ repo: 'clean', headSha })).toBe(false);
    expect(reads).toBe(1);
    expect(required({ repo: 'pending', headSha })).toBe(true);
    expect(required({ repo: 'missing', headSha })).toBe(true);
    expect(required({ repo: 'clean' })).toBe(true);
    expect(createBranchPreparationRequired({ ...options, serial: true })({ repo: 'clean', headSha })).toBe(true);
    expect(createBranchPreparationRequired({ enabled: false })({})).toBe(false);
  });
  it('reduces gate reads for 20 PRs in candidate order with identical serial classification', async () => {
    const prs = Array.from({ length: 20 }, (_, i) => ({ number: i + 1, headRefOid: `sha-${i}`, body: 'Fix the drain scheduling.',
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', isDraft: i % 5 === 0,
      labels: [{ name: 'ready-to-merge' }], commits: [{ messageHeadline: 'Fix', authors: [{ name: 'Claude', email: 'noreply@anthropic.com' }] }],
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: i % 3 ? 'SUCCESS' : 'FAILURE' }] }));
    const read = async concurrency => {
      let active = 0, peak = 0;
      const reads = await fetchPrReadsCached(prs, { concurrency, cache: new Map(), keyOf: p => p.number,
        shaOf: p => p.headRefOid, fetchOne: async p => {
          peak = Math.max(peak, ++active);
          await new Promise(resolve => setTimeout(resolve, (21 - p.number) % 4));
          active--;
          return p;
        } });
      return { verdicts: [...reads].map(([num, r]) => ({ num, ...classifyPr(r.value) })), peak };
    };
    const serial = await read(1), parallel = await read(6);
    expect(parallel.verdicts).toEqual(serial.verdicts);
    expect(parallel.verdicts.map(v => v.num)).toEqual(prs.map(p => p.number));
    expect(new Set(parallel.verdicts.map(v => v.decision))).toEqual(new Set(['merge', 'skip']));
    expect(serial.peak).toBe(1);
    expect(parallel.peak).toBe(6);
  });

  it.each([1, 3])('caps enqueue preparation at %i and isolates a failed PR', async concurrency => {
    let active = 0, peak = 0;
    const completed = [], failed = [];
    await runEnqueueCandidates(Array.from({ length: 20 }, (_, num) => ({ num })), {
      concurrency, canParallel: () => true, onError: (c, e) => failed.push([c.num, e.message]),
      run: async c => {
        peak = Math.max(peak, ++active);
        try { await pause(); if (c.num === 2) throw new Error('one PR failed'); completed.push(c.num); }
        finally { active--; }
      },
    });
    expect(peak).toBe(concurrency);
    expect(failed).toEqual([[2, 'one PR failed']]);
    if (concurrency === 1) expect(completed).toEqual(Array.from({ length: 20 }, (_, n) => n).filter(n => n !== 2));
    expect(completed.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, n) => n).filter(n => n !== 2));
  });

  it('runs numbering, rebase, main writes and coupled PRs alone between parallel batches', async () => {
    const candidates = [{ num: 1 }, { num: 2 }, { num: 3, numbering: true }, { num: 4, numbering: true },
      { num: 5 }, { num: 6, rebaseDrop: 'rebased' }, { num: 7, rebaseDrop: 'needed' },
      { num: 8, writesMain: true }, { num: 9, couple: true }, { num: 10 }, { num: 11 }];
    let active = 0;
    const events = [], failures = [];
    const eligible = c => canParallelEnqueue(c, { enqueues: !c.writesMain, numbering: !!c.numbering,
      mayRefresh: false, coupled: !!c.couple });
    await runEnqueueCandidates(candidates, { concurrency: 3, canParallel: eligible,
      onError: (_c, e) => failures.push(e), run: async c => {
      events.push(`start:${c.num}`);
      if (!eligible(c)) expect(active).toBe(0);
      active++;
      await pause();
      if (!eligible(c)) expect(active).toBe(1);
      active--;
      events.push(`end:${c.num}`);
    } });
    expect(failures).toEqual([]);
    for (const c of candidates.filter(c => !eligible(c))) {
      expect(events.indexOf(`end:${c.num}`)).toBe(events.indexOf(`start:${c.num}`) + 1);
    }
    expect(events.indexOf('start:3')).toBeGreaterThan(events.indexOf('end:2'));
    expect(events.indexOf('start:5')).toBeGreaterThan(events.indexOf('end:4'));
  });

  it('fails closed for refresh-capable preparation and logs each setting source', () => {
    expect(canParallelEnqueue({}, { enqueues: true, mayRefresh: true })).toBe(false);
    expect(canParallelEnqueue({}, { enqueues: true })).toBe(true);
    const policy = resolveMergeDeliveryPolicy({ platform: { concurrency: { gateReads: 4 } }, tool: { concurrency: { enqueue: 1 } } });
    expect(formatConcurrencySources(policy)).toBe('concurrency.gateReads=4 (platform), concurrency.enqueue=1 (tool)');
  });

  it.each([0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid concurrency %s per key without losing a valid override', value => {
    const policy = resolveMergeDeliveryPolicy({ platform: { concurrency: { gateReads: 4, enqueue: 2 } },
      tool: { concurrency: { gateReads: value, enqueue: 1 } } });
    expect(policy.concurrency).toEqual({ gateReads: 4, enqueue: 1 });
    expect(policy.sources['concurrency.gateReads']).toBe('platform');
    expect(policy.sources['concurrency.enqueue']).toBe('tool');
    expect(policy.invalid).toEqual([`tool.concurrency.gateReads=${JSON.stringify(value)}`]);
  });

  it('uses default widths and rejects malformed concurrency blocks', () => {
    const policy = resolveMergeDeliveryPolicy({ tool: { concurrency: [] } });
    expect(policy.concurrency).toEqual({ gateReads: 6, enqueue: 3 });
    expect(policy.invalid).toEqual(['tool.concurrency: not an object']);
  });

  it('wires the live cascade to the scheduler and fresh async throttled reads', () => {
    const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    expect(source).toContain('await runEnqueueCandidates(coupleStep.ordered');
    expect(source).toContain('concurrency: resolvedMergePolicy.policy.concurrency.enqueue');
    expect(source).toContain('concurrency: resolvedMergePolicy.policy.concurrency.gateReads');
    expect(source).toContain('const { stdout: raw } = await execFileP');
    expect(source).toContain('formatConcurrencySources(resolvedMergePolicy.policy)');
    expect(source.includes('if (shouldPrepareBranchBeforeEnqueue({ required: branchPreparationRequired(c), enqueues: mergeStrategy.enqueues(c.repo) })) {')).toBe(true);
  });
});
