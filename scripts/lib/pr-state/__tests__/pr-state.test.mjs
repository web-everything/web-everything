/** derivePrState over ledger events: one table row per lifecycle state, the hold rules, #5083 and the replays. */
import { describe, it, expect } from 'vitest';
import { derivePrState, labelsToLedgerState, ledgerView } from '../../pr-state.mjs';
import { deriveReferrals, ledgerFindingKey } from '../referrals.mjs';
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
const facts = (o = {}) => ({ pr: PR, repo, now: at(300), state: 'OPEN', isDraft: false, head: { sha: H1, committedAt: at(0) },
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
    const ctx = { view: ledgerView([], facts()), facts: facts(), settings: {} };
    const codes = evaluateHolds(ctx, rules).map(h => h.code);
    expect(codes).toEqual(['rule-crashed:boom', 'rule-crashed:junk', 'c']); // built-ins ran too and had nothing to say
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

describe('finding keys: a ruling closes the referral whichever form it names (slice H shadow, ruling-key-unhashed)', () => {
  const raw = '["judgeCorrectnessAdvisory","scripts/x.mjs",12,"a finding"]';
  const hashed = ledgerFindingKey(raw);
  it('the ledger form is sha256:<hex> of the raw key, and hashing twice is a no-op', () => {
    expect(hashed).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ledgerFindingKey(hashed)).toBe(hashed);
  });
  it('a hashed ruling closes a hashed referral', () => {
    expect(deriveReferrals([referral(1, H1, hashed), ruling(5, hashed, 'not-real')]).get(hashed).state).toBe('ruled');
  });
  it('an OLD raw-key ruling row still closes the hashed referral it answers', () => {
    expect(deriveReferrals([referral(1, H1, hashed), ruling(5, raw, 'block')]).get(hashed)).toMatchObject({ state: 'blocking', ruling: 'block' });
    expect(state([referral(1, H1, hashed), ruling(5, raw, 'card')], facts()).holds.map(h => h.code)).not.toContain('referral-unruled');
  });
  it('a ruling for a different finding closes nothing', () => {
    expect(deriveReferrals([referral(1, H1, hashed), ruling(5, 'another', 'not-real')]).get(hashed).state).toBe('open');
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

describe('fail closed: every hold rule defaults to deny (review of PR #4326)', () => {
  const approval = (m, d) => ev('approval', m, { approval: 'judge', delegation: d });
  const expired = { by: 'op', scope: 'pr', expires: at(10) };
  const live10 = { by: 'op', scope: 'pr', expires: at(600) };
  const held = out => expect(out.lifecycleState).toBe('NEEDS-OPERATOR');

  describe('approval validity is one predicate for the verdict and the label-input path', () => {
    const humanVerdict = [verdict(VERDICTS.HUMAN, 1)];
    const handLabel = [verdict(VERDICTS.ACCEPTED, 1), ev('label-input', 4, { label: 'review:human', sender: 'someone', change: 'added' })];
    it.each([['verdict-based human hold', humanVerdict], ['hand-added human label', handLabel]])('%s: an expired delegation keeps the hold, a live one lifts it', (_n, base) => {
      held(state([...base, approval(5, expired)], facts({ now: at(60) })));
      expect(state([...base, approval(5, live10)], facts({ now: at(60) })).lifecycleState).toBe('READY-TO-MERGE');
      expect(state([...base, approval(5, null)], facts({ now: at(60) })).lifecycleState).toBe('READY-TO-MERGE');
    });
    it.each([['verdict-based human hold', humanVerdict], ['hand-added human label', handLabel]])('%s: a missing or unparseable now, or a non-finite expiry, never lifts a delegated approval', (_n, base) => {
      held(state([...base, approval(5, expired)], facts({ now: undefined })));
      held(state([...base, approval(5, expired)], facts({ now: 'not a time' })));
      const hand = { ...approval(5, expired), delegation: { ...expired, expires: 'garbage' } }; // the builder refuses this; a raw ledger row might not
      held(state([...base, hand], facts()));
    });
    it('an approval that PRECEDES the human verdict lifts nothing', () => {
      held(state([approval(0, null), verdict(VERDICTS.HUMAN, 1)], facts()));
    });
  });

  describe('a clearing verdict lifts a hand-added hold only if it covers the current head', () => {
    const added = ev('label-input', 4, { label: 'review:human', sender: 'someone', change: 'added' });
    it('an accept witnessed on another head, or on no head, leaves the label hold', () => {
      const f = facts({ head: { sha: H2, committedAt: at(3) } });
      expect(state([added, verdict(VERDICTS.ACCEPTED, 9, H1)], f).holds.map(h => h.code)).toContain('label-input:review:human');
      expect(state([added, verdict(VERDICTS.ACCEPTED, 9, null)], f).holds.map(h => h.code)).toContain('label-input:review:human');
      expect(state([added, verdict(VERDICTS.ACCEPTED, 9, H2)], f).holds.map(h => h.code)).not.toContain('label-input:review:human');
    });
  });

  describe('the ledger is scoped to this PR in this repo', () => {
    const other = (o = {}) => buildVerdictRecord({ repo, pr: PR, verdict: VERDICTS.ACCEPTED, at: at(1), source: 'test', headSha: H1, reason: 'r', ...o });
    it('facts without pr or repo hold (unknown scope is never "all PRs")', () => {
      const events = [other({ pr: 999 })];
      expect(state(events, facts({ pr: undefined })).holds.map(h => h.code)).toEqual(['scope-unknown']);
      expect(state([other()], facts({ repo: undefined })).holds.map(h => h.code)).toEqual(['scope-unknown']);
      held(state([other()], facts({ pr: undefined })));
    });
    it("another PR's accept, or the same number in another repo, never clears this one", () => {
      expect(state([other({ pr: 999 })], facts()).clears).toBe(false);
      expect(state([other({ repo: 'other-org/other-repo' })], facts()).clears).toBe(false);
      expect(state([other({ repo: 'Web-Everything/Web-Everything' })], facts()).clears).toBe(true); // slugs compare case-insensitively
    });
  });

  describe('settings.holdRules adds to the built-ins and never replaces them', () => {
    it.each([[[]], [undefined], [null], ['junk']])('holdRules=%j still holds on a human verdict and on a stale acceptance', holdRules => {
      expect(state([verdict(VERDICTS.HUMAN, 1)], facts(), { holdRules }).lifecycleState).toBe('NEEDS-OPERATOR');
      const stale = state([verdict(VERDICTS.ACCEPTED, 1, H1)], facts({ head: { sha: H2, committedAt: at(5) } }), { holdRules });
      expect(stale.holds.map(h => h.code)).toContain('stale-acceptance');
    });
    it('a custom rule adds its own hold next to the built-ins', () => {
      const out = state([verdict(VERDICTS.HUMAN, 1)], facts(), { holdRules: [{ id: 'extra', evaluate: () => ({ code: 'extra', reason: 'r' }) }] });
      expect(out.holds.map(h => h.code)).toEqual(['verdict:human', 'extra']);
    });
  });

  describe('an acceptance with no witnessed head does not cover a known head', () => {
    it('accepted with no headSha holds as stale; with the right head it clears', () => {
      const out = state([verdict(VERDICTS.ACCEPTED, 1, null)], facts());
      expect(out.holds.map(h => h.code)).toContain('stale-acceptance');
      expect(out.clears).toBe(false);
      expect(state([verdict(VERDICTS.ACCEPTED, 1, H1)], facts()).clears).toBe(true);
    });
  });

  describe('a block ruling keeps holding until a fix is observed', () => {
    const base = [referral(1, H1, 'k1'), ruling(2, 'k1', 'block')];
    it('block then accept on the SAME head: still held, in NEEDS-OPERATOR (not a ruling anyone owes)', () => {
      const out = state([...base, verdict(VERDICTS.ACCEPTED, 5, H1)], facts());
      expect(deriveReferrals([...base, verdict(VERDICTS.ACCEPTED, 5, H1)]).get('k1').state).toBe('blocking');
      expect(out.holds.map(h => h.code)).toEqual(['referral-blocked']);
      expect(out.lifecycleState).toBe('NEEDS-OPERATOR');
      expect(out.clears).toBe(false);
    });
    it('block then accept on a NEW head: resolved-by-fix, clear', () => {
      const events = [...base, verdict(VERDICTS.ACCEPTED, 5, H2)];
      expect(deriveReferrals(events).get('k1')).toMatchObject({ state: 'resolved-by-fix', resolvedAtHead: H2 });
      expect(state(events, facts({ head: { sha: H2, committedAt: at(4) } })).lifecycleState).toBe('READY-TO-MERGE');
    });
    it('not-real and card rulings still close the finding', () => {
      for (const r of ['not-real', 'card']) {
        const out = state([referral(1, H1, 'k1'), ruling(2, 'k1', r), verdict(VERDICTS.ACCEPTED, 5, H1)], facts());
        expect(out.holds).toEqual([]);
      }
    });
  });

  describe('the send-back releases on a new head SHA, never on a commit timestamp', () => {
    const events = [verdict(VERDICTS.ACCEPTED, 1, H1), ev('send-back', 10, { cause: 'changes' })];
    it('the same SHA with a future-dated committedAt stays sent back', () => {
      expect(state(events, facts({ head: { sha: H1, committedAt: at(500) } })).holds.map(h => h.code)).toContain('send-back');
    });
    it('a new SHA with a committedAt older than the send-back (clock skew) is released', () => {
      expect(state(events, facts({ head: { sha: H2, committedAt: at(2) } })).holds.map(h => h.code)).not.toContain('send-back');
    });
    it('no recorded head before the send-back, or no current head: stays sent back (a later event on the same head proves nothing)', () => {
      const bare = [ev('send-back', 10, { cause: 'changes' })];
      const f = facts({ head: { sha: H2, committedAt: at(20) } });
      const codes = evs => state(evs, f).holds.map(h => h.code);
      expect(codes(bare)).toContain('send-back');
      // A later observation establishes the CURRENT sha, not that it differs from the sent-back one (review of PR #4326, round 3).
      for (const later of [ev('review-run', 15, { headSha: H2, phase: 'started', posted: null }), ev('review-run', 15, { headSha: H2, phase: 'completed', posted: false }), verdict(VERDICTS.CHANGES, 15, H2), referral(15, H2, 'k1')]) {
        expect(codes([...bare, later])).toContain('send-back');
      }
      expect(state(events, facts({ head: undefined })).holds.map(h => h.code)).toContain('send-back');
    });
  });

  describe('review of PR #4326, round 3: every ledger row is untrusted input', () => {
    const codes = out => out.holds.map(h => h.code);
    const rawVerdict = (o = {}) => ({ type: 'verdict', repo, pr: PR, verdict: 'accepted', clears: true, at: at(1), headSha: H1, ...o });

    describe('an invalid row for this PR holds as ledger-unreadable instead of throwing or being skipped', () => {
      const lbl = ev('label-input', 3, { label: 'review:human', sender: 'someone', change: 'added' });
      it.each([
        ['referral without findingKeys', { ...referral(2, H1, 'k'), findingKeys: undefined }],
        ['referral with a string findingKeys (would iterate characters)', { ...referral(2, H1, 'k'), findingKeys: 'abc' }],
        ['referral with a non-string key inside findingKeys', { ...referral(2, H1, 'k'), findingKeys: [{}] }],
        ['referral with an empty findingKeys', { ...referral(2, H1, 'k'), findingKeys: [] }],
        ['referral with a garbage headSha', { ...referral(2, H1, 'k'), headSha: 'garbage-xx' }],
        ['ruling without findingKey', { ...ruling(2, 'k', 'block'), findingKey: undefined }],
        ['ruling with a non-string findingKey', { ...ruling(2, 'k', 'block'), findingKey: { toString: 1 } }],
        ['review-run with a numeric headSha', { ...ev('review-run', 2, { headSha: H1, phase: 'started', posted: null }), headSha: 5 }],
        ['a string pr that the fold would skip', { ...verdict(VERDICTS.CHANGES, 2), pr: String(PR) }],
        ['an array pr', { ...verdict(VERDICTS.CHANGES, 2), pr: [PR] }],
        ['a mis-cased verdict type', { ...verdict(VERDICTS.CHANGES, 2), type: 'Verdict' }],
        ['a hold with a trailing-space type', { ...ev('hold', 2, { reasonCode: 'x', holdSource: 'y' }), type: 'hold ' }],
        ['an unknown event type', { ...ev('hold', 2, { reasonCode: 'x', holdSource: 'y' }), type: 'freeze' }],
        ['a label-input with a mis-cased change', { ...lbl, change: 'Added' }],
        ['an approval with no kind', { ...ev('approval', 5, { approval: 'judge', delegation: null }), approval: undefined }],
        ['an approval with an unknown kind', { ...ev('approval', 5, { approval: 'judge', delegation: null }), approval: 'lol' }],
      ])('%s', (_n, row) => {
        const out = state([verdict(VERDICTS.ACCEPTED, 1), row], facts());
        expect(codes(out)).toEqual(['ledger-unreadable']);
        expect(out).toMatchObject({ lifecycleState: 'NEEDS-OPERATOR', clears: false });
      });
      it('a row that cannot be attributed to a PR and repo holds every PR; another PR\'s invalid payload is not ours', () => {
        expect(codes(state([verdict(VERDICTS.ACCEPTED, 1), { ...verdict(VERDICTS.CHANGES, 2), pr: 'x' }], facts()))).toEqual(['ledger-unreadable']);
        const elsewhere = { ...referral(2, H1, 'k'), pr: 999, findingKeys: 'abc' };
        expect(state([verdict(VERDICTS.ACCEPTED, 1), elsewhere], facts()).clears).toBe(true);
      });
      it('a forged clears field never clears: it is derived from the verdict word', () => {
        for (const v of [VERDICTS.CHANGES, VERDICTS.HUMAN, VERDICTS.PENDING]) {
          const out = state([verdict(VERDICTS.ACCEPTED, 1), { ...verdict(v, 2), clears: true }], facts());
          expect(out.clears).toBe(false);
          expect(out.lifecycleState).not.toBe('READY-TO-MERGE');
        }
      });
      it('a hostile row (a throwing getter, a Proxy) holds; it never throws', () => {
        const trap = new Proxy({}, { get() { throw new Error('boom'); } });
        expect(codes(state([trap], facts()))).toEqual(['derive-crashed']);
        expect(codes(state([{ get pr() { throw new Error('boom'); } }], facts()))).toEqual(['derive-crashed']);
      });
      it.each([[null], ['junk'], [42]])('settings=%j never throws and the built-ins still hold', settings => {
        const out = state([verdict(VERDICTS.HUMAN, 1)], facts(), settings);
        expect(out.lifecycleState).toBe('NEEDS-OPERATOR');
        expect(labelsToLedgerState(facts({ labels: ['review:accepted'] }), settings).lifecycleState).toBe('READY-TO-MERGE');
      });
      it('a crash anywhere in the fold or the core holds as derive-crashed; it never throws', () => {
        const hostile = facts({ requiredChecks: { get some() { throw new Error('boom'); } } });
        expect(codes(state([verdict(VERDICTS.ACCEPTED, 1)], hostile))).toEqual(['derive-crashed']);
      });
    });

    describe('an unknown current head never lets an acceptance clear', () => {
      it.each([[undefined], [{}], [{ sha: null }], [{ sha: '' }], [{ sha: 'abc' }]])('facts.head=%j', head => {
        const out = state([verdict(VERDICTS.ACCEPTED, 1, H1)], facts({ head }));
        expect(codes(out)).toContain('stale-acceptance');
        expect(out).toMatchObject({ clears: false });
        expect(out.lifecycleState).not.toBe('READY-TO-MERGE');
      });
      it('also for an approval-lifted human verdict', () => {
        const out = state([verdict(VERDICTS.HUMAN, 1), ev('approval', 5, { approval: 'judge', delegation: null })], facts({ head: undefined }));
        expect(out.clears).toBe(false);
      });
    });

    describe('defense in depth: the rules themselves default to deny on a raw view (they are public extension-point inputs)', () => {
      const rawVerdict = (o = {}) => ({ type: 'verdict', repo, pr: PR, verdict: 'accepted', clears: true, at: at(1), headSha: H1, ...o });
      const run = (events, f, current = null) => evaluateHolds({ view: { events, folded: current ? { current } : null, clears: !!current, referrals: deriveReferrals(events) }, facts: f, settings: {} }).map(h => h.code);
      const headed = sha => facts({ head: { sha, committedAt: at(3) } });
      it('a clearing row with a top-level headSha and no coverage object covers only that exact head', () => {
        const row = rawVerdict();
        expect(run([row], headed(H2), row)).toContain('stale-acceptance');
        expect(run([row], headed(H1), row)).not.toContain('stale-acceptance');
      });
      it('label-input: the coverage-less accept for another head leaves a hand-added hold', () => {
        const added = ev('label-input', 0, { label: 'review:human', sender: 'someone', change: 'added' });
        expect(run([added, rawVerdict()], headed(H2))).toContain('label-input:review:human');
        expect(run([added, rawVerdict({ headSha: H2 })], headed(H2))).not.toContain('label-input:review:human');
      });
      it('a coverage object that names no head is not rescued by a top-level headSha', () => {
        const row = rawVerdict({ coverage: { headSha: null } });
        expect(run([row], headed(H1), row)).toContain('stale-acceptance');
      });
      it.each([['abc'], ['zzzzzzzz'], [null], ['']])('send-back: a current head of %j is unknown, so it never releases', head => {
        const events = [verdict(VERDICTS.ACCEPTED, 1, H1), ev('send-back', 10, { cause: 'changes' })];
        expect(state(events, facts({ head: { sha: head, committedAt: at(20) } })).holds.map(h => h.code)).toContain('send-back');
      });
      it('a non-string current head never clears (it holds, whichever rule or the core trips first)', () => {
        const out = state([verdict(VERDICTS.ACCEPTED, 1, H1), ev('send-back', 10, { cause: 'changes' })], facts({ head: { sha: 5, committedAt: at(20) } }));
        expect(out.clears).toBe(false);
        expect(out.lifecycleState).not.toBe('READY-TO-MERGE');
      });
      it('send-back: a garbage baseline head is not a baseline', () => {
        const events = [{ type: 'review-run', repo, pr: PR, headSha: 'garbage-zz', phase: 'started' }, ev('send-back', 10, { cause: 'changes' })];
        expect(run(events, headed(H1))).toContain('send-back');
      });
      it('referrals: a garbage head on the referral or on the clearing verdict resolves nothing', () => {
        const garbage = { type: 'referral', repo, pr: PR, headSha: 'garbage-xx', findingKeys: ['k1'] };
        expect(deriveReferrals([garbage, rawVerdict()]).get('k1').state).toBe('open');
        expect(deriveReferrals([referral(1, H1, 'k1'), rawVerdict({ headSha: 'garbage-xx' })]).get('k1').state).toBe('open');
      });
      it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf'])('ruling=%s closes nothing, and an end-to-end derive rejects the row', name => {
        const forged = { ...ruling(2, 'k1', 'block'), ruling: name };
        expect(deriveReferrals([referral(1, H1, 'k1'), forged]).get('k1').state).toBe('open');
        expect(codes(state([verdict(VERDICTS.ACCEPTED, 1), referral(1, H1, 'k1'), forged], facts()))).toEqual(['ledger-unreadable']);
      });
    });
  });
});
