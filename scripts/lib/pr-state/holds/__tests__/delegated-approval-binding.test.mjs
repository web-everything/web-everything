import { describe, it, expect } from 'vitest';
import { derivePrState } from '../../../pr-state.mjs';
import { buildVerdictRecord, buildLedgerEvent, ledgerEventId, VERDICTS } from '../../../verdict-ledger.mjs';
import { approvalBindsHold } from '../verdict.mjs';
import { planLabelInputRows } from '../../../../conveyor/pr-label-mirror.mjs';
import { HOLD_LABELS } from '../label-input.mjs';

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

describe('companion clear-human verdict binding', () => {
  const clear = () => buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.CLEAR_HUMAN,
    at: at(4), source: 'review-set-label', headSha: HEAD });
  const approve = (basis, overrides = {}) => ev('approval', 5, {
    approval: 'clear-human', delegation, headSha: HEAD, basis, ...overrides,
  });
  const bounce = (verdict, m) => buildVerdictRecord({ repo, pr: PR, verdict,
    at: at(m), source: 'test', headSha: HEAD, reason: 'review bounce/rearm' });

  describe.each([
    ['changes', [VERDICTS.CHANGES]],
    ['pending', [VERDICTS.PENDING]],
    ['changes then pending', [VERDICTS.CHANGES, VERDICTS.PENDING]],
    ['repeated bounce with observation', [VERDICTS.CHANGES, VERDICTS.PENDING,
      VERDICTS.OBSERVED, VERDICTS.CHANGES, VERDICTS.PENDING]],
  ])('human hold across %s', (_name, sequence) => {
    const history = () => [human(), ...sequence.map((v, i) => bounce(v, i + 2))];
    const ceremony = () => ({ ...clear(), at: at(20) });
    const approval = (overrides = {}) => ({ ...approve([ledgerEventId(human())], overrides), at: at(21) });

    it.each([
      ['no approval', null],
      ['different head', { headSha: OLD_HEAD }],
      ['missing head', { headSha: undefined }],
      ['missing basis', { basis: undefined }],
      ['missing both bindings', { headSha: undefined, basis: undefined }],
      ['wrong hold', { basis: [ledgerEventId(label(0))] }],
      ['expired delegation', { delegation: { ...delegation, expires: at(299) } }],
    ])('refuses clear-human with %s', (_case, overrides) => {
      const events = [...history(), ceremony(), ...(overrides === null ? [] : [approval(overrides)])];
      const state = derivePrState(events, facts());
      expect(state).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
      expect(state.holds.map(h => h.code)).toContain('verdict:human');
    });

    it.each([delegation, null])('allows a valid companion approval (delegation: %j)', delegated => {
      expect(derivePrState([...history(), ceremony(), approval({ delegation: delegated })], facts()))
        .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
    });

    it('does not let an approval alone clear a later bounce or rearm verdict', () => {
      const state = derivePrState([...history(), approval()], facts());
      expect(state.clears).toBe(false);
      expect(state.holds.length).toBeGreaterThan(0);
      expect(state.lifecycleState).not.toBe('READY-TO-MERGE');
    });

    it('cannot reuse approval for an earlier human hold after a new human verdict', () => {
      const second = { ...human(), at: at(10) };
      expect(derivePrState([...history(), approval(), second, bounce(VERDICTS.PENDING, 22), ceremony()], facts()))
        .toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
    });

    it.each([VERDICTS.ACCEPTED, VERDICTS.RESTAMPED])('%s still supersedes the human hold', verdict => {
      expect(derivePrState([...history(), bounce(verdict, 22)], facts()))
        .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
    });
  });

  it('keeps an unnamed hand-added hold when the companion verdict is present', () => {
    const verdict = human(), hold = label(2);
    const approval = approve([ledgerEventId(verdict)]);
    for (const events of [[verdict, hold, approval], [verdict, hold, clear(), approval]]) {
      const state = derivePrState(events, facts());
      expect(state).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
      expect(state.holds.map(h => h.code)).toContain('label-input:review:human');
    }
  });

  it.each([
    ['different head', { headSha: OLD_HEAD }],
    ['expired delegation', { delegation: { ...delegation, expires: at(299) } }],
    ['missing head', { headSha: undefined }],
    ['missing basis', { basis: undefined }],
  ])('the companion verdict cannot rescue an approval with %s', (_name, overrides) => {
    const verdict = human(), hold = label(2);
    const state = derivePrState([verdict, hold, clear(),
      approve([ledgerEventId(verdict), ledgerEventId(hold)], overrides)], facts());
    expect(state).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
    expect(state.holds.map(h => h.code)).toContain('verdict:human');
    expect(state.holds.map(h => h.code)).toContain('label-input:review:human');
  });

  it('fails closed between the verdict append and the approval append', () => {
    const verdict = human(), hold = label(2);
    const state = derivePrState([verdict, hold, clear()], facts());
    expect(state).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
    expect(state.holds.map(h => h.code)).toContain('verdict:human');
    expect(state.holds.map(h => h.code)).toContain('label-input:review:human');
  });

  it('clears when a valid approval explicitly names both holds', () => {
    const verdict = human(), hold = label(2);
    expect(derivePrState([verdict, hold, clear(), approve([ledgerEventId(verdict), ledgerEventId(hold)])], facts()))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it('preserves an operator approval without binding fields', () => {
    expect(derivePrState([human(), label(2), clear(),
      ev('approval', 5, { approval: 'clear-human', delegation: null })], facts()))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it.each([null, delegation])('uses the companion head witness after a valid approval (delegation: %j)', delegated => {
    const verdict = buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.HUMAN,
      at: at(1), source: 'test', headSha: OLD_HEAD });
    expect(derivePrState([verdict, clear(), approve([ledgerEventId(verdict)], { delegation: delegated })], facts()))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it('does not let the companion verdict clear a re-added mirrored hold outside basis', () => {
    const verdict = human(), first = label(2), second = { ...label(3), clearanceBaseline: [] };
    expect(codes([verdict, first, clear(), approve([ledgerEventId(verdict), ledgerEventId(first)]), second]))
      .toContain('label-input:review:human');
  });

  it.each(HOLD_LABELS)('requires approval binding for %s even without a human verdict', name => {
    const hold = ev('label-input', 2, { label: name, sender: 'operator', change: 'added' });
    expect(codes([hold, clear(), approve([ledgerEventId(label(1))])])).toContain(`label-input:${name}`);
    expect(codes([hold, clear(), approve([ledgerEventId(hold)])])).not.toContain(`label-input:${name}`);
  });

  it('retains the original human hold id across explicit verdict rows, observations and retries', () => {
    const verdict = { type: 'verdict', ...human() };
    const observation = buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.OBSERVED,
      at: at(6), source: 'test', headSha: HEAD });
    const retry = { ...clear(), at: at(7) };
    expect(codes([verdict, clear(), observation, retry, approve([ledgerEventId(label(1))])]))
      .toContain('verdict:human');
    expect(derivePrState([verdict, clear(), observation, retry, approve([ledgerEventId(verdict)])], facts()))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it('keeps a newly added human verdict outside an earlier approval basis', () => {
    const first = human(), second = { ...human(), at: at(6) };
    expect(codes([first, clear(), approve([ledgerEventId(first)]), second, { ...clear(), at: at(7) }]))
      .toContain('verdict:human');
  });

  it('an ordinary later acceptance still supersedes the human verdict', () => {
    const accepted = buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.ACCEPTED,
      at: at(8), source: 'test', headSha: HEAD });
    expect(derivePrState([human(), clear(), accepted], facts()))
      .toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, holds: [] });
  });

  it('fails closed for an unknown clock even with both holds named', () => {
    const verdict = human(), hold = label(2);
    expect(derivePrState([verdict, hold, clear(), approve([ledgerEventId(verdict), ledgerEventId(hold)])],
      { ...facts(), now: undefined })).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
  });

  it('the mirror records a hold despite the delegated clearance companion verdict', () => {
    const verdict = human(), approval = approve([ledgerEventId(verdict)]);
    const options = { repo, pr: PR, selfLogin: 'mirror', headSha: HEAD, now: at(300),
      liveLabels: ['review:human'], items: [{ label: 'review:human', change: 'added',
        actor: 'operator', createdAt: at(2), id: 'hand-addition' }] };
    for (const events of [[verdict, clear()], [verdict, clear(), approval]]) {
      const rows = planLabelInputRows({ ...options, events });
      expect(rows).toHaveLength(1);
      expect(codes([...events, ...rows])).toContain('label-input:review:human');
    }
    expect(planLabelInputRows({ ...options, events: [clear(),
      ev('approval', 5, { approval: 'clear-human', delegation: null })] })).toEqual([]);
  });
});

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
