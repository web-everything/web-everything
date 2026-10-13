import { describe, it, expect } from 'vitest';
import { derivePrState } from '../pr-state.mjs';
import { decideLedgerGate } from '../pr-merge-gate.mjs';
import { shadowRow } from '../drain-ledger-shadow.mjs';
import { buildLedgerEvent, buildVerdictRecord, foldVerdictLedger } from '../verdict-ledger.mjs';
import { projectDrainFactsRow, reclassifyRow } from '../ledger-promotion-readiness.mjs';
const repo = 'o/r', head = 'a'.repeat(40), now = '2026-10-13T12:00:00.000Z';
const base = { repo, pr: 1, at: now, source: 'test', declaredActor: 'drain' };
const exempt = sha => buildLedgerEvent({ ...base, type: 'review-exempt', headSha: sha, basis: 'no review needed' });
const facts = { repo, pr: 1, head: { sha: head }, now, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] };
describe('exact-head review exemption', () => {
  const pending = buildVerdictRecord({ ...base, verdict: 'pending', headSha: head, reason: 'review' });
  const hold = buildLedgerEvent({ ...base, type: 'hold', reasonCode: 'review', holdSource: 'drain' });
  it.each(['exact', 'upper', 'missing', 'short', 'different', 'pending', 'hold', 'last-different', 'unreadable', 'bad-head'])('%s is fail-closed', kind => {
    const rows = { exact: [exempt(head)], upper: [exempt(head.toUpperCase())], missing: [], short: [exempt('aaaaaaaa')], different: [exempt('b'.repeat(40))], pending: [exempt(head), pending], hold: [exempt(head), hold], 'last-different': [exempt(head), exempt('b'.repeat(40))], unreadable: null, 'bad-head': [exempt(head)] }[kind];
    const input = kind === 'bad-head' ? { ...facts, head: { sha: 'aaaaaaaa' } } : facts;
    const derived = derivePrState(rows, input), clear = ['exact', 'upper'].includes(kind);
    expect(derived.clears).toBe(clear); expect(derived.reviewExempt).toBe(clear);
    expect(derived.labels).not.toContain('review:accepted');
    const folded = foldVerdictLedger((rows ?? []).filter(e => !e.type || e.type === 'verdict')).get(1) ?? { current: null, clears: false };
    expect(decideLedgerGate({ authority: 'ledger', folded, derived, head: input.head }).clear).toBe(clear);
  });
  it('shadow agrees only at the exempt head', () => {
    const args = { repo, verdict: { num: 1, decision: 'merge', listedHeadSha: head }, now };
    expect(shadowRow({ ...args, events: [exempt(head)] })).toMatchObject({ status: 'agree', ledgerHolds: [] });
    expect(shadowRow({ ...args, events: [exempt('b'.repeat(40))] }).status).toBe('disagree');
  });
});
describe('drain-fact replay projection', () => {
  const row = { status: 'disagree', direction: 'ledger-holds-label-clears', reason: 'no ledger row for this PR' };
  it.each([['no-ledger-row'], ['stale-acceptance'], ['hold:drain:review'], ['no-ledger-row', 'stale-acceptance', 'hold:drain:ci']].map(codes => [codes]))('projects %j', code => {
    expect(projectDrainFactsRow({ ...row, ledgerHolds: code })).toMatchObject({ status: 'agree', direction: null, projected: true });
  });
  it('parses legacy reasons and preserves real or unsafe disagreement', () => {
    expect(projectDrainFactsRow(reclassifyRow(row)).status).toBe('agree');
    expect(projectDrainFactsRow({ ...row, reason: 'ledger holds: stale-acceptance, hold:drain:review' }).status).toBe('agree');
    for (const r of [{ ...row, ledgerHolds: ['stale-acceptance', 'verdict:pending'] }, { ...row, direction: 'ledger-clears-label-holds' }, { ...row, reason: 'unknown' }, { ...row, status: 'unreadable' }]) expect(projectDrainFactsRow(r)).toBe(r);
  });
});
