/**
 * @file scripts/readiness/__tests__/carry-forward.test.mjs
 * @description Pins the parallel-orchestrator closeout carry-forward / reopen decision (#2072/#2086) — the
 * bug-prone logic (a wrong call cascades across 12+ items per batch) extracted from the workflow sandbox into
 * a pure, tested module. The workflow inline-mirrors these functions; this module + test are the spec.
 */
import { describe, it, expect } from 'vitest';
import { classifyEntry, computeReopenSet, partitionCloseout } from '../carry-forward.mjs';

const S = (...nums) => new Set(nums.map(String));

describe('classifyEntry', () => {
  const claimed = S('010', '011', '012');
  it('a resolved entry is resolved', () => {
    expect(classifyEntry({ num: '010', status: 'resolved' }, claimed)).toBe('resolved');
  });
  it('an un-resolved entry this run claimed → reopen', () => {
    expect(classifyEntry({ num: '011', status: 'carried' }, claimed)).toBe('reopen');
    expect(classifyEntry({ num: '012', status: 'dropped' }, claimed)).toBe('reopen');
  });
  it('an un-resolved entry NOT claimed by this run → foreign (leave it)', () => {
    expect(classifyEntry({ num: '099', status: 'carried' }, claimed)).toBe('foreign');
  });
  it('legacy fallback — empty claim scope reopens every un-resolved entry', () => {
    expect(classifyEntry({ num: '099', status: 'carried' }, S())).toBe('reopen');
    expect(classifyEntry({ num: '099', status: 'carried' }, undefined)).toBe('reopen');
  });
  it('a null entry is treated as resolved (nothing to reopen)', () => {
    expect(classifyEntry(null, claimed)).toBe('resolved');
  });
});

describe('computeReopenSet — synthetic batch scenarios', () => {
  it('an all-green batch reopens nothing', () => {
    const ledger = [
      { num: '010', status: 'resolved' },
      { num: '011', status: 'resolved' },
    ];
    expect(computeReopenSet(ledger, S('010', '011'))).toEqual([]);
  });

  it('a mixed batch reopens only the un-resolved items this run claimed', () => {
    const ledger = [
      { num: '010', status: 'resolved' },
      { num: '011', status: 'carried', drop: 'blocked-in-fact' },
      { num: '012', status: 'dropped', drop: 'outgrew' },
    ];
    expect(computeReopenSet(ledger, S('010', '011', '012'))).toEqual(['011', '012']);
  });

  it('never reopens an item another session owns (claim-scope boundary #2072)', () => {
    const ledger = [
      { num: '011', status: 'carried' }, // ours, failed → reopen
      { num: '099', status: 'carried' }, // NOT in claimedThisRun → leave it
    ];
    expect(computeReopenSet(ledger, S('011'))).toEqual(['011']);
  });

  it('dedups a cross-repo item that appears once per repo in the ledger', () => {
    const ledger = [
      { num: '020', status: 'carried', repo: 'we' },
      { num: '020', status: 'carried', repo: 'frontierui' },
      { num: '021', status: 'resolved' },
    ];
    expect(computeReopenSet(ledger, S('020', '021'))).toEqual(['020']);
  });

  it('preserves first-seen ledger order (deterministic)', () => {
    const ledger = [
      { num: '030', status: 'carried' },
      { num: '031', status: 'resolved' },
      { num: '029', status: 'dropped' },
    ];
    expect(computeReopenSet(ledger, S('029', '030', '031'))).toEqual(['030', '029']);
  });

  it('legacy fallback — empty claim scope reopens every un-resolved item', () => {
    const ledger = [
      { num: '010', status: 'resolved' },
      { num: '011', status: 'carried' },
      { num: '099', status: 'dropped' },
    ];
    expect(computeReopenSet(ledger, S())).toEqual(['011', '099']);
  });

  it('tolerates a null / non-array ledger', () => {
    expect(computeReopenSet(null, S('010'))).toEqual([]);
    expect(computeReopenSet([null, undefined], S('010'))).toEqual([]);
  });
});

describe('partitionCloseout — the full one-call closeout summary', () => {
  it('buckets every item into resolved / reopen / foreign, deduped', () => {
    const ledger = [
      { num: '010', status: 'resolved' },
      { num: '011', status: 'carried' },
      { num: '011', status: 'carried' }, // dup (cross-repo)
      { num: '099', status: 'carried' }, // foreign
    ];
    expect(partitionCloseout(ledger, S('010', '011'))).toEqual({
      closed: [], resolved: ['010'],
      reopen: ['011'],
      foreign: ['099'],
    });
  });

  it('reopen bucket equals computeReopenSet for the same inputs', () => {
    const ledger = [
      { num: '010', status: 'resolved' },
      { num: '011', status: 'carried' },
      { num: '012', status: 'dropped' },
    ];
    const claimed = S('010', '011', '012');
    expect(partitionCloseout(ledger, claimed).reopen).toEqual(computeReopenSet(ledger, claimed));
  });
});

 it('never reopens a closed ledger entry or counts it as delivered', () => {
   expect(classifyEntry({ num: '010', status: 'closed' }, new Set(['010']))).toBe('closed');
   expect(partitionCloseout([{ num: '010', status: 'closed' }], new Set(['010']))).toEqual({ resolved: [], closed: ['010'], reopen: [], foreign: [] });
 });
