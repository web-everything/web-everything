/** derivePrState over ledger events: one table row per lifecycle state, the hold rules, #5083 and the replays. */
import { describe, it, expect } from 'vitest';
import { derivePrState, labelsToLedgerState } from '../../pr-state.mjs';
import { deriveReferrals } from '../referrals.mjs';
import { evaluateHolds } from '../holds/index.mjs';
import { LIFECYCLE_STATE_NAMES, renderLabels, HUMAN_HOLD_CI_RED } from '../../../conveyor/pr-lifecycle.mjs';
import { buildVerdictRecord, buildLedgerEvent, VERDICTS } from '../../verdict-ledger.mjs';

const repo = 'web-everything/web-everything', PR = 4017;
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), H3 = 'c'.repeat(40);
const T0 = Date.parse('2026-10-06T08:00:00Z');
const at = m => new Date(T0 + m * 60_000).toISOString();
const verdict = (v, m, head = H1) => buildVerdictRecord({ repo, pr: PR, verdict: v, at: at(m), source: 'test', headSha: head, reason: 'r' });
const ev = (type, m, o = {}) => buildLedgerEvent({ type, repo, pr: PR, at: at(m), source: 'test', ...o });
const referral = (m, head, ...keys) => ev('referral', m, { headSha: head, findingKeys: keys });
const ruling = (m, key, r) => ev('ruling', m, { findingKey: key, ruling: r });
const facts = (o = {}) => ({ pr: PR, now: at(300), state: 'OPEN', isDraft: false, head: { sha: H1, committedAt: at(0) },
  requiredChecks: [{ name: 'test', state: 'green' }], sessions: [], handoffs: [], refusals: [], ...o });
const live = { name: 'rev', kind: 'review', live: true, state: 'busy', startedAt: at(290) };
const state = (events, f, s) => derivePrState(events, f, s);

describe('one row per lifecycle state', () => {
  const rows = [
    ['WAITING-CI', [], facts({ requiredChecks: [{ name: 'test', state: 'pending' }] })],
    ['IN-REVIEW', [verdict(VERDICTS.PENDING, 1)], facts({ now: at(20) , sessions: [live] })],
    ['FIXING', [verdict(VERDICTS.CHANGES, 1)], facts({ sessions: [{ name: 'fix', kind: 'fix', live: true, state: 'busy', startedAt: at(290) }] })],
    ['HANDED-OFF', [verdict(VERDICTS.CHANGES, 1)], facts({ handoffs: [{ kind: 'load-flake', at: at(290), detail: 'x' }] })],
    ['NEEDS-RULING', [verdict(VERDICTS.ACCEPTED, 1), referral(2, H1, 'k1')], facts()],
    ['NEEDS-OPERATOR', [verdict(VERDICTS.HUMAN, 1)], facts()],
    [HUMAN_HOLD_CI_RED, [verdict(VERDICTS.HUMAN, 1)], facts({ requiredChecks: [{ name: 'test', state: 'red' }] })],
    ['READY-TO-MERGE', [verdict(VERDICTS.ACCEPTED, 1)], facts()],
    ['STUCK', [verdict(VERDICTS.CHANGES, 1)], facts()],
    ['MERGED', [verdict(VERDICTS.ACCEPTED, 1)], facts({ state: 'MERGED' })],
    ['CLOSED', [], facts({ state: 'CLOSED' })],
  ];
  it('the table covers every declared state', () => expect(rows.map(r => r[0]).sort()).toEqual([...LIFECYCLE_STATE_NAMES].sort()));
  it.each(rows)('%s', (name, events, f) => {
    const out = state(events, f);
    expect(out.lifecycleState).toBe(name);
    expect(out.labels).toEqual(renderLabels(name));
    expect(out.owner).toBeTruthy();
    expect(out.phase.evidence.length).toBeGreaterThan(0); // the core's evidence is carried, not recomputed
  });
  it('an unreadable ledger holds and is never read as empty', () => {
    const out = state(null, facts());
    expect(out).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
    expect(out.holds[0].code).toBe('ledger-unreadable');
    expect(state([], facts()).holds).toEqual([]);
  });
  it('facts.labels never decide: labels are an output', () => {
    expect(state([verdict(VERDICTS.CHANGES, 1)], facts({ labels: ['review:accepted', 'ready-to-merge'] })).lifecycleState).not.toBe('READY-TO-MERGE');
  });
});

describe('the core is the only phase derivation', () => {
  it('ledger and label paths agree on a ready PR, and on a human gate with a red check', () => {
    expect(labelsToLedgerState(facts({ labels: ['review:accepted'] })).lifecycleState).toBe('READY-TO-MERGE');
    expect(labelsToLedgerState(facts({ labels: ['review:human'], requiredChecks: [{ name: 'test', state: 'red' }] })).lifecycleState).toBe(HUMAN_HOLD_CI_RED);
    expect(labelsToLedgerState(facts({ labels: ['review:human'] })).lifecycleState).toBe('NEEDS-OPERATOR');
    expect(labelsToLedgerState(facts({ labels: ['review:accepted'] })).lifecycleState).toBe(state([verdict(VERDICTS.ACCEPTED, 1)], facts()).lifecycleState);
  });
});

describe('hold rules', () => {
  it('a stale acceptance on a newer head does not clear', () => {
    const out = state([verdict(VERDICTS.ACCEPTED, 1, H1)], facts({ head: { sha: H2, committedAt: at(5) } }));
    expect(out.holds.map(h => h.code)).toContain('stale-acceptance');
    expect(out.clears).toBe(false);
    expect(out.lifecycleState).not.toBe('READY-TO-MERGE');
  });
  it('a send-back holds until a newer head', () => {
    const events = [verdict(VERDICTS.ACCEPTED, 1), ev('send-back', 10, { cause: 'changes' })];
    expect(state(events, facts()).holds.map(h => h.code)).toContain('send-back');
    expect(state(events, facts({ head: { sha: H2, committedAt: at(20) } })).holds.map(h => h.code)).not.toContain('send-back');
  });
  it('hold and release events: the last per source and reason wins', () => {
    const hold = m => ev('hold', m, { reasonCode: 'load-flake', holdSource: 'drain' });
    const release = m => ev('release', m, { reasonCode: 'load-flake', holdSource: 'drain' });
    const base = [verdict(VERDICTS.ACCEPTED, 1)];
    expect(state([...base, hold(2)], facts()).lifecycleState).toBe('NEEDS-OPERATOR');
    expect(state([...base, hold(2), release(3)], facts()).lifecycleState).toBe('READY-TO-MERGE');
  });
  it('the same-head cap holds only while nothing clears, and 0 turns it off', () => {
    const run = ev('review-run', 2, { headSha: H1, phase: 'completed', posted: false });
    expect(state([verdict(VERDICTS.OBSERVED, 1), run], facts()).holds.map(h => h.code)).toContain('same-head-cap');
    expect(state([verdict(VERDICTS.ACCEPTED, 1), run], facts()).holds).toEqual([]);
    expect(state([verdict(VERDICTS.OBSERVED, 1), run], facts(), { sameHeadMaxReviews: 0 }).holds).toEqual([]);
  });
  it('a hand-added hold label holds; a hand removal releases nothing; a later clear lifts it', () => {
    const added = ev('label-input', 5, { label: 'review:human', sender: 'someone', change: 'added' });
    const removed = ev('label-input', 6, { label: 'review:changes', sender: 'someone', change: 'removed' });
    expect(state([verdict(VERDICTS.ACCEPTED, 1), added], facts()).lifecycleState).toBe('NEEDS-OPERATOR');
    const heldByChanges = state([verdict(VERDICTS.CHANGES, 1), removed], facts());
    expect(heldByChanges.clears).toBe(false);
    expect(state([added, verdict(VERDICTS.ACCEPTED, 9)], facts()).holds).toEqual([]);
  });
  it('an approval lifts a human hold unless its delegation expired', () => {
    const approval = d => ev('approval', 5, { approval: 'judge', delegation: d });
    const human = verdict(VERDICTS.HUMAN, 1);
    expect(state([human, approval(null)], facts()).lifecycleState).toBe('READY-TO-MERGE');
    const expired = { by: 'op', scope: 'pr', expires: at(10) };
    expect(state([human, approval(expired)], facts({ now: at(60) })).lifecycleState).toBe('NEEDS-OPERATOR');
    expect(state([human, approval({ ...expired, expires: at(600) })], facts()).lifecycleState).toBe('READY-TO-MERGE');
  });
  it('a crashing rule holds with rule-crashed:<id>, and a malformed one too; the others still run', () => {
    const rules = [{ id: 'boom', evaluate() { throw new Error('x'); } }, { id: 'junk', evaluate: () => ({ nope: 1 }) }, { id: 'ok', evaluate: () => ({ code: 'c', reason: 'r' }) }];
    const codes = evaluateHolds({}, rules).map(h => h.code);
    expect(codes).toEqual(['rule-crashed:boom', 'rule-crashed:junk', 'c']);
    const out = state([verdict(VERDICTS.ACCEPTED, 1)], facts(), { holdRules: rules });
    expect(out.lifecycleState).toBe('NEEDS-OPERATOR');
    expect(out.clears).toBe(false);
  });
});

describe('referrals (#5083: a later accept on a new head closes them)', () => {
  it('open until a clearing verdict on a different head: resolved-by-fix with that head', () => {
    const r = deriveReferrals([referral(1, H1, 'k1'), verdict(VERDICTS.ACCEPTED, 5, H2)]);
    expect(r.get('k1')).toMatchObject({ state: 'resolved-by-fix', resolvedAtHead: H2 });
    const out = state([verdict(VERDICTS.CHANGES, 0), referral(1, H1, 'k1'), verdict(VERDICTS.ACCEPTED, 5, H2)], facts({ head: { sha: H2, committedAt: at(4) } }));
    expect(out.lifecycleState).toBe('READY-TO-MERGE');
  });
  it('still reproduced (a newer referral names the key) keeps holding', () => {
    const events = [referral(1, H1, 'k1'), verdict(VERDICTS.ACCEPTED, 5, H2), referral(6, H2, 'k1')];
    expect(deriveReferrals(events).get('k1').state).toBe('open');
    expect(state(events, facts({ head: { sha: H2, committedAt: at(4) } })).lifecycleState).toBe('NEEDS-RULING');
  });
  it('not accepted: a changes verdict, or an accept on the SAME head, closes nothing', () => {
    expect(deriveReferrals([referral(1, H1, 'k1'), verdict(VERDICTS.CHANGES, 5, H2)]).get('k1').state).toBe('open');
    expect(deriveReferrals([referral(1, H1, 'k1'), verdict(VERDICTS.ACCEPTED, 5, H1)]).get('k1').state).toBe('open');
    expect(deriveReferrals([referral(1, H1, 'k1'), verdict(VERDICTS.OBSERVED, 5, H2)]).get('k1').state).toBe('open');
  });
  it('only the closed keys close: another open key keeps the PR in NEEDS-RULING', () => {
    const r = deriveReferrals([referral(1, H1, 'k1'), verdict(VERDICTS.ACCEPTED, 5, H2), referral(6, H3, 'k2')]);
    expect([r.get('k1').state, r.get('k2').state]).toEqual(['resolved-by-fix', 'open']);
  });
});

describe('replays: no ruling needed', () => {
  const noRuling = out => expect(out.holds.map(h => h.code)).not.toContain('referral-unruled');
  it('plateau-app #202: a block on head 1 overruled not-real on head 2; the finding returning on head 3 is quiet', () => {
    const events = [referral(1, H1, 'k1'), ruling(5, 'k1', 'not-real'), referral(12, H3, 'k1')];
    noRuling(state(events, facts({ head: { sha: H3, committedAt: at(11) } })));
    expect(deriveReferrals(events).get('k1').state).toBe('ruled');
  });
  it('a block ruling that comes back is NOT quiet (the dispute stays with the operator)', () => {
    expect(deriveReferrals([referral(1, H1, 'k1'), ruling(5, 'k1', 'block'), referral(12, H3, 'k1')]).get('k1').state).toBe('open');
  });
  it('#3964 shape: every finding ruled, then accepted on the next head; release implies the gate is clear', () => {
    const events = [referral(1, H1, 'k1', 'k2'), ruling(2, 'k1', 'card'), ruling(3, 'k2', 'not-real'), verdict(VERDICTS.ACCEPTED, 9, H2)];
    const out = state(events, facts({ head: { sha: H2, committedAt: at(8) } }));
    noRuling(out);
    expect(out).toMatchObject({ lifecycleState: 'READY-TO-MERGE', clears: true, needsYou: [] });
  });
});
