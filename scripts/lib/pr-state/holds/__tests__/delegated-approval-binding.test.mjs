import { describe, it, expect } from 'vitest';
import { derivePrState } from '../../../pr-state.mjs';
import { buildVerdictRecord, buildLedgerEvent, ledgerEventId, VERDICTS } from '../../../verdict-ledger.mjs';

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

  it.each([
    ['malformed headSha', { headSha: 'not-a-sha' }],
    ['empty basis', { basis: [] }],
  ])('rejects delegated approval with %s at construction', (_name, invalid) => {
    expect(() => approve({ headSha: HEAD, basis: [ledgerEventId(label(1))], ...invalid })).toThrow();
  });
});
