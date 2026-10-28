import { describe, it, expect } from 'vitest';
import { derivePrState } from '../../../pr-state.mjs';
import { buildVerdictRecord, buildLedgerEvent, ledgerEventId, VERDICTS } from '../../../verdict-ledger.mjs';
import { approvalBindsHold } from '../verdict.mjs';

const repo = 'web-everything/web-everything', PR = 4017;
const HEAD = 'b'.repeat(40), OLD_HEAD = 'a'.repeat(40);
const T0 = Date.parse('2026-10-06T08:00:00Z');
const at = m => new Date(T0 + m * 60_000).toISOString();
const ev = (type, m, o = {}) => buildLedgerEvent({ type, repo, pr: PR, at: at(m), source: 'test', ...o });
const delegation = { by: 'op', scope: 'pr', expires: at(600) };
const facts = () => ({ pr: PR, repo, now: at(300), state: 'OPEN', isDraft: false,
  head: { sha: HEAD, committedAt: at(0) }, requiredChecks: [{ name: 'test', state: 'green' }],
  sessions: [], handoffs: [], refusals: [] });
const codes = events => derivePrState(events, facts()).holds.map(h => h.code);
const label = m => ev('label-input', m, { label: 'review:human', sender: 'someone', change: 'added' });
const human = () => buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.HUMAN,
  at: at(1), source: 'test', headSha: HEAD, reason: 'human review required' });

describe.each(['clear-human', 'judge'])('%s approval binding', approval => {
  const approve = (o = {}) => ev('approval', 5, { approval, delegation, ...o });

  describe.each([
    ['hand-added label', () => label(1), 'label-input:review:human'],
    ['human verdict', human, 'verdict:human'],
  ])('%s', (_name, makeHold, code) => {
    it('lifts the hold with the current head and its event id in basis', () => {
      const hold = makeHold();
      expect(codes([hold])).toContain(code);
      expect(codes([hold, approve({ headSha: HEAD, basis: [ledgerEventId(hold)] })])).not.toContain(code);
    });

    it('fails closed for an older head even when basis names the hold', () => {
      const hold = makeHold();
      expect(codes([hold, approve({ headSha: OLD_HEAD, basis: [ledgerEventId(hold)] })])).toContain(code);
    });

    it.each([7, 12, 39])('fails closed for a persisted approval with a %i-character head prefix', length => {
      const hold = makeHold();
      const approvalRow = approve({ headSha: HEAD, basis: [ledgerEventId(hold)] });
      approvalRow.headSha = HEAD.slice(0, length);
      expect(approvalBindsHold(approvalRow, ledgerEventId(hold), HEAD)).toBe(false);
      const state = derivePrState([hold, approvalRow], facts());
      expect(state).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
      expect(state.holds.map(h => h.code)).toContain('ledger-unreadable');
    });

    it.each([7, 12, 39])('fails closed for a %i-character current head, including equal abbreviations', length => {
      const hold = makeHold();
      const approvalRow = approve({ headSha: HEAD, basis: [ledgerEventId(hold)] });
      const abbreviatedFacts = { ...facts(), head: { sha: HEAD.slice(0, length), committedAt: at(0) } };
      const holds = () => derivePrState([hold, approvalRow], abbreviatedFacts).holds.map(h => h.code);
      expect(holds()).toContain(code);
      approvalRow.headSha = abbreviatedFacts.head.sha;
      expect(approvalBindsHold(approvalRow, ledgerEventId(hold), abbreviatedFacts.head.sha)).toBe(false);
      expect(holds()).toContain('ledger-unreadable');
    });

    it.each([null, 1234567, '', 'b'.repeat(41), 'b'.repeat(64), `${HEAD}\n`, ` ${HEAD}`])(
      'refuses malformed full-head evidence %j in the hold predicate', invalid => {
        const hold = makeHold(), id = ledgerEventId(hold);
        const approvalRow = approve({ headSha: HEAD, basis: [id] });
        expect(approvalBindsHold({ ...approvalRow, headSha: invalid }, id, invalid)).toBe(false);
        expect(approvalBindsHold(approvalRow, id, invalid)).toBe(false);
        expect(approvalBindsHold({ ...approvalRow, headSha: invalid }, id, HEAD)).toBe(false);
      });

    it('fails closed when basis names a different hold', () => {
      const hold = makeHold();
      expect(codes([hold, approve({ headSha: HEAD, basis: [ledgerEventId(label(0))] })])).toContain(code);
    });

    it.each(['headSha', 'basis', 'both'])('fails closed with missing %s', missing => {
      const hold = makeHold();
      const binding = { headSha: HEAD, basis: [ledgerEventId(hold)] };
      if (missing === 'both') {
        expect(codes([hold, approve()])).toContain(code);
      } else {
        delete binding[missing];
        expect(codes([hold, approve(binding)])).toContain(code);
      }
    });

    it('preserves operator approval without headSha or basis', () => {
      expect(codes([makeHold(), approve({ delegation: null })])).not.toContain(code);
    });
  });

  it('does not lift a label re-added after approval when basis names only the first addition', () => {
    const first = label(1), second = label(6);
    expect(ledgerEventId(second)).not.toBe(ledgerEventId(first));
    const approvalRow = approve({ headSha: HEAD, basis: [ledgerEventId(first)] });
    expect(codes([first, approvalRow, second])).toContain('label-input:review:human');
  });

  it('keeps an accepted PR held when an approval abbreviates a different commit with the same prefix', () => {
    const currentHead = '1234567' + 'b'.repeat(33), oldHead = '1234567' + 'a'.repeat(33);
    const accepted = buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.ACCEPTED,
      at: at(1), source: 'test', headSha: currentHead });
    const hold = label(2), id = ledgerEventId(hold);
    const approvalRow = approve({ headSha: oldHead, basis: [id] });
    const currentFacts = { ...facts(), head: { sha: currentHead, committedAt: at(0) } };
    for (const events of [[accepted, hold], [accepted, hold, approvalRow],
      [accepted, hold, { ...approvalRow, headSha: '1234567' }]]) {
      expect(derivePrState(events, currentFacts)).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
    }
    expect(approvalBindsHold({ ...approvalRow, headSha: '1234567' }, id, currentHead)).toBe(false);
    expect(derivePrState([accepted, hold, { ...approvalRow, headSha: currentHead }], currentFacts))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it('compares full heads case-insensitively, matching ledger normalization', () => {
    const hold = label(1), id = ledgerEventId(hold);
    const approvalRow = approve({ headSha: ` ${HEAD.toUpperCase()} `, basis: [id] });
    expect(approvalRow.headSha).toBe(HEAD);
    expect(approvalBindsHold(approvalRow, id, HEAD.toUpperCase())).toBe(true);
  });

  it('preserves operator approval with an abbreviated head witness', () => {
    const hold = label(1);
    expect(codes([hold, approve({ delegation: null, headSha: HEAD.slice(0, 7) })]))
      .not.toContain('label-input:review:human');
  });

  it.each([
    ['malformed headSha', { headSha: 'not-a-sha' }],
    ...[7, 12, 39].map(length => [`${length}-character headSha`, { headSha: HEAD.slice(0, length) }]),
    ['empty basis', { basis: [] }],
  ])('rejects delegated approval with %s at construction', (_name, invalid) => {
    expect(() => approve({ headSha: HEAD, basis: [ledgerEventId(label(1))], ...invalid })).toThrow();
  });
});
