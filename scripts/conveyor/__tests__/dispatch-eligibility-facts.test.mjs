import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { redTeamGateMarker, liveResultGateState } from '../../lib/red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../../lib/review-verdict-carried-marker.mjs';
import { eligibility } from '../dispatch-eligibility.mjs';
import { buildEligibilityFacts, redTeamFact } from '../dispatch-eligibility-facts.mjs';
import { enrichPrsWithAlreadyLandedFacts } from '../reconcile-pass.mjs';

const head = 'a'.repeat(40), oldHead = 'b'.repeat(40), pr = 6001;
const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
const result = (rev, confirmed = true) => bot(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm',
  recheckStatus: 'ok', foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [1].map(i => ({
    summary: `Break ${i}`, category: 'edge-case', impactIfUnfixed: 'broken',
    file: 'scripts/example.mjs', line: i, confirmedByRecheck: true })) : [] }));
const human = body => ({ author: { login: 'chalbert', type: 'User' }, body });
const prState = { number: pr, state: 'OPEN', isDraft: false, labels: [], headRefOid: head };
const goodLocals = () => ({
  referral: { state: 'none' }, scope: 'present', claim: { claimed: false }, pause: { paused: false },
  sameHead: { spent: false }, rounds: { attempts: 0, cap: 2 },
});
const clearComments = (() => {
  const r = result(head, false);
  return [r, bot(`${redTeamGateMarker(pr, head, 'no-send-back', liveResultGateState([r], pr, head).resultId)}\ngate`)];
})();
const build = (over = {}) => buildEligibilityFacts({
  pr: prState, comments: clearComments, commentsComplete: true, population: 'fix', locals: goodLocals(), ...over });

describe('buildEligibilityFacts', () => {
  it('a fully read PR yields facts the gate dispatches on', () => {
    const facts = build();
    expect(eligibility({ ...prState, commentsComplete: true }, facts)).toMatchObject({ dispatch: true });
  });

  it.each(['referral', 'scope', 'claim', 'pause', 'sameHead', 'rounds'])('a failed %s read is unread', (name) => {
    for (const bad of [{ readFailed: true }, undefined, null]) {
      const locals = { ...goodLocals(), [name]: bad };
      expect(build({ locals })[name]).toEqual({ status: 'unread' });
      expect(eligibility({ ...prState, commentsComplete: true }, build({ locals }))).toEqual({ unknown: name });
    }
  });

  it('a malformed local is unread, never coerced to a known false', () => {
    expect(build({ locals: { ...goodLocals(), claim: {} } }).claim).toEqual({ status: 'unread' });
    expect(build({ locals: { ...goodLocals(), rounds: { attempts: 'x', cap: 2 } } }).rounds).toEqual({ status: 'unread' });
    expect(build({ locals: { ...goodLocals(), scope: 'bogus' } }).scope).toEqual({ status: 'unread' });
  });

  it('known scope values pass through', () => {
    for (const scope of ['present', 'empty', 'too-large']) {
      expect(build({ locals: { ...goodLocals(), scope } }).scope).toEqual({ status: 'known', value: scope });
    }
  });

  it('an unknown population is unread', () => {
    expect(build({ population: 'nope' }).population).toEqual({ status: 'unread' });
  });

  it('already-landed: marker is landed; unlabelled PR is known not-landed; conflict-labelled with no read is unread', () => {
    expect(build({ pr: { ...prState, alreadyLandedInMain: { carrierPr: 5 } } }).alreadyLanded)
      .toEqual({ status: 'known', value: 'landed' });
    expect(build().alreadyLanded).toEqual({ status: 'known', value: 'not-landed' });
    const conflicting = { ...prState, labels: [{ name: 'merge-status:conflicting' }] };
    expect(build({ pr: conflicting }).alreadyLanded).toEqual({ status: 'unread' });
    expect(build({ pr: conflicting, alreadyLanded: { status: 'unread' } }).alreadyLanded).toEqual({ status: 'unread' });
    expect(build({ pr: conflicting, alreadyLanded: { status: 'known', value: 'not-landed' } }).alreadyLanded)
      .toEqual({ status: 'known', value: 'not-landed' });
  });

  it('an incomplete thread makes the gate unknown', () => {
    expect(eligibility({ ...prState, commentsComplete: false }, build({ commentsComplete: false }))).toEqual({ unknown: 'thread' });
  });
});

const gateFor = (comments, rev, outcome, who = bot) => who(`${redTeamGateMarker(pr, rev, outcome, liveResultGateState(comments, pr, rev).resultId)}\ngate`);
describe('redTeamFact (gate store only; everything unmapped is unread)', () => {
  const unreadFact = { status: 'unread' };
  it('a gate record of no-send-back (clear) for the current head is clear', () => {
    const comments = [result(head, false)];
    comments.push(gateFor(comments, head, 'no-send-back'));
    const id = liveResultGateState(comments, pr, head).resultId;
    expect(redTeamFact(comments, pr, head)).toEqual({ status: 'known', value: { state: 'clear', resultId: id, sendBackResultId: null } });
  });
  it('a gate record for an OLDER head only is unread', () => {
    const comments = [result(oldHead, false)];
    comments.push(gateFor(comments, oldHead, 'no-send-back'));
    expect(redTeamFact(comments, pr, head)).toEqual(unreadFact);
  });
  it('no result at all, a bad thread or a bad head is unread', () => {
    expect(redTeamFact([], pr, head)).toEqual(unreadFact);
    expect(redTeamFact(undefined, pr, head)).toEqual(unreadFact);
    expect(redTeamFact([], pr, 'short')).toEqual(unreadFact);
  });
  it('a live result with no gate record is unread, not clear or pending', () => {
    expect(redTeamFact([result(head, false)], pr, head)).toEqual(unreadFact);
    expect(redTeamFact([result(head)], pr, head)).toEqual(unreadFact);
  });
  it('an uppercase marker with no gate record is unread', () => {
    const upper = bot(result(head, false).body.replace('we:red-team-advisory', 'WE:RED-TEAM-ADVISORY'));
    expect(redTeamFact([upper], pr, head)).toEqual(unreadFact);
  });
  it('an indented confirmed finding with no gate record is unread', () => {
    const indented = bot(`${result(head, false).body}\n  1. [**confirmed**] (edge-case, broken) \`a.mjs:1\` — hidden break`);
    expect(redTeamFact([indented], pr, head)).toEqual(unreadFact);
  });
  it('a malformed or carried result with no gate record is unread', () => {
    const bad = bot(`${result(head, false).body}\n1. [**confirmed**] malformed`);
    expect(redTeamFact([bad], pr, head)).toEqual(unreadFact);
    const base = result(oldHead, false);
    const carried = bot([buildVerdictCarriedMarker({ fromSha: oldHead, toSha: head, patchId: 'c'.repeat(40) }),
      'Review verdict carried across an identical contribution.',
      base.body.replace(oldHead, head), '1. [**confirmed**] malformed'].join('\n'));
    expect(redTeamFact([base, carried], pr, head)).toEqual(unreadFact);
  });
  it('a round-cap gate record on the live result is held', () => {
    const comments = [result(head)];
    comments.push(gateFor(comments, head, 'round-cap'));
    expect(redTeamFact(comments, pr, head).value.state).toBe('held');
  });
  it('a sent-back gate record is a send-back bound to the live result id', () => {
    const comments = [result(head)];
    comments.push(gateFor(comments, head, 'sent-back'));
    const id = liveResultGateState(comments, pr, head).resultId;
    expect(redTeamFact(comments, pr, head).value).toEqual({ state: 'send-back', resultId: id, sendBackResultId: id });
  });
  it('an operator-block record is blocked', () => {
    const comments = [result(head, false)];
    comments.push(gateFor(comments, head, 'operator-block', human));
    expect(redTeamFact(comments, pr, head).value.state).toBe('blocked');
  });
  it('a send-back recorded for another result id is not a bound send-back', () => {
    const comments = [result(head)];
    comments.push(bot(`${redTeamGateMarker(pr, head, 'sent-back', 'f'.repeat(16))}\nx`));
    const v = redTeamFact(comments, pr, head);
    expect(v.status === 'unread' || v.value.state !== 'send-back').toBe(true);
  });
});


describe('reconcile-pass shadow fact', () => {
  const labelled = { number: pr, headRefOid: head, labels: [{ name: 'merge-status:conflicting' }] };
  const noop = () => {};
  it('a failed merge-base read returns the PR unchanged and reports alreadyLanded unread', () => {
    const seen = [];
    const out = enrichPrsWithAlreadyLandedFacts([labelled], {
      fetchRef: noop, readMergeBase: () => null, onShadowFact: (n, f) => seen.push([n, f]) });
    expect(out).toEqual([labelled]);
    expect(out[0]).toBe(labelled);
    expect(seen).toEqual([[pr, { alreadyLanded: { status: 'unread' } }]]);
  });
  it('a failed diff read returns the PR unchanged and reports alreadyLanded unread', () => {
    const seen = [];
    const out = enrichPrsWithAlreadyLandedFacts([labelled], {
      fetchRef: noop, readMergeBase: () => 'c'.repeat(40), readChanges: () => [], onShadowFact: (n, f) => seen.push([n, f]) });
    expect(out[0]).toBe(labelled);
    expect(seen).toEqual([[pr, { alreadyLanded: { status: 'unread' } }]]);
  });
  it('without the callback behaviour is identical (snapshot of the unchanged return)', () => {
    expect(enrichPrsWithAlreadyLandedFacts([labelled], { fetchRef: noop, readMergeBase: () => null })).toEqual([labelled]);
  });
});

