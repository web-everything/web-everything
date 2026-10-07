import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decideLedgerGate, DEFAULT_REVIEW_AUTHORITY, REVIEW_AUTHORITIES } from '../pr-merge-gate.mjs';

const clearFolded = { clears: true, current: { coverage: { headSha: 'aaa' } } };
const clearDerived = { clears: true, holds: [] };
const heldFolded = { clears: false, current: {} };
const heldDerived = { clears: false, holds: [{ code: 'verdict:changes' }] };
const sha = { sha: 'aaa' };

const ledgers = {
  clear: { folded: clearFolded, derived: clearDerived, head: sha },
  held: { folded: heldFolded, derived: heldDerived, head: sha },
  stale: { folded: clearFolded, derived: clearDerived, head: { sha: 'bbb' } },
  unreadableNull: { folded: null, derived: null, head: sha },
  unreadableFlag: { folded: { unreadable: true }, derived: clearDerived, head: sha },
  unreadableHold: { folded: clearFolded, derived: { clears: false, holds: [{ code: 'ledger-unreadable' }] }, head: sha },
  holdDespiteClears: { folded: clearFolded, derived: { clears: true, holds: [{ code: 'same-head-cap' }] }, head: sha },
};

describe('decideLedgerGate table', () => {
  // [authority, ledger, labelsClear, clear, defer]
  const rows = [
    ['labels', 'clear', true, true, false], ['labels', 'clear', false, false, false],
    ['labels', 'held', true, true, false], ['labels', 'unreadableNull', true, true, false],
    ['labels', 'unreadableNull', false, false, false],
    ['both', 'clear', true, true, false], ['both', 'clear', false, false, false],
    ['both', 'held', true, false, false], ['both', 'held', false, false, false],
    ['both', 'stale', true, false, false], ['both', 'holdDespiteClears', true, false, false],
    ['both', 'unreadableNull', true, false, true], ['both', 'unreadableFlag', true, false, true],
    ['both', 'unreadableHold', true, false, true], ['both', 'unreadableNull', false, false, true],
    ['ledger', 'clear', false, true, false], ['ledger', 'clear', true, true, false],
    ['ledger', 'held', true, false, false], ['ledger', 'stale', true, false, false],
    ['ledger', 'unreadableNull', true, false, true],
    ['bogus', 'clear', false, false, false], ['bogus', 'held', true, false, false], ['bogus', 'clear', true, true, false],
    [undefined, 'held', true, true, false],
  ];
  it.each(rows)('%s / %s / labelsClear=%s -> clear=%s defer=%s', (authority, l, labelsClear, clear, defer) => {
    const r = decideLedgerGate({ ...ledgers[l], labelsClear, authority });
    expect(r.clear).toBe(clear);
    expect(r.defer).toBe(defer);
    expect(r.reason).toBeTruthy();
  });

  it('both never clears what labels holds, for every ledger shape', () => {
    for (const l of Object.values(ledgers)) {
      expect(decideLedgerGate({ ...l, labelsClear: false, authority: 'both' }).clear).toBe(false);
    }
  });

  it('both never clears more than labels would, with any inputs', () => {
    for (const l of Object.values(ledgers)) for (const lc of [true, false]) {
      const both = decideLedgerGate({ ...l, labelsClear: lc, authority: 'both' });
      const labels = decideLedgerGate({ ...l, labelsClear: lc, authority: 'labels' });
      if (both.clear) expect(labels.clear).toBe(true);
    }
  });

  it('never throws on empty input and defaults to labels', () => {
    expect(decideLedgerGate().clear).toBe(false);
    expect(decideLedgerGate().authority).toBe('labels');
  });
});

describe('mergeGate.reviewAuthority setting', () => {
  it('defaults to labels and is one of the declared values', () => {
    expect(DEFAULT_REVIEW_AUTHORITY).toBe('labels');
    expect(REVIEW_AUTHORITIES).toEqual(['labels', 'both', 'ledger']);
  });
  it('the mjs mirror matches config/platformDefaults.ts', () => {
    const ts = readFileSync(resolve(process.cwd(), 'config/platformDefaults.ts'), 'utf8');
    expect(ts).toMatch(/PLATFORM_MERGE_GATE_DEFAULTS = \{\s*reviewAuthority: 'labels' as 'labels' \| 'both' \| 'ledger'/);
  });
});
