import { expect, it } from 'vitest';
import smell from '../fix-loop-no-push.mjs';
import { validateSmellShape } from '../../health-smells-shape.mjs';
const now = Date.parse('2026-10-05T12:00:00Z'), head = 'a'.repeat(40);
const rows = Array.from({ length: 3 }, () => ({ v: 1, at: new Date(now).toISOString(), repo: 'we', pr: 3990, head, kind: 'ci-heal' }));
const evaluate = (headRefOid = head, ledger = rows, env = {}) => smell.evaluate({
  prs: [{ repo: 'web-everything/web-everything', number: 3990, headRefOid }], fixLoopLedger: ledger,
}, { now, env });
it('validates the smell and reports three sessions on the current head', () => {
  expect(validateSmellShape(smell, 'fix-loop-no-push.mjs')).toBe(smell);
  expect(evaluate()).toEqual([expect.objectContaining({ subject: 'pr:we#3990', breach: true,
    measure: { count: 3, head, kinds: { 'ci-heal': 3 }, windowHours: 6, held: true } })]);
});
it('ignores moved heads and counts below threshold', () => {
  expect(evaluate('b'.repeat(40))).toEqual([]);
  expect(evaluate(head, rows.slice(1))).toEqual([]);
});
it('still alerts with automatic holds disabled', () => {
  expect(evaluate(head, rows, { WE_FIX_LOOP_HOLD: '0' })[0].measure.held).toBe(false);
});
