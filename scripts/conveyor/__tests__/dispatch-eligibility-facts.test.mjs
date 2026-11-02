import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { redTeamGateMarker, liveResultGateState } from '../../lib/red-team-gate.mjs';
import { eligibility } from '../dispatch-eligibility.mjs';
import { buildEligibilityFacts, redTeamFact } from '../dispatch-eligibility-facts.mjs';
import { enrichPrsWithAlreadyLandedFacts } from '../reconcile-pass.mjs';

const head = 'a'.repeat(40), oldHead = 'b'.repeat(40), pr = 6001;
const bot = body => ({ author: { login: 'web-everything', type: 'Bot' }, body });
const result = (rev, confirmed = true) => bot(renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm',
  recheckStatus: 'ok', foldedVerdict: confirmed ? 'changes' : 'accept', findings: confirmed ? [1].map(i => ({
    summary: `Break ${i}`, category: 'edge-case', impactIfUnfixed: 'broken',
    file: 'scripts/example.mjs', line: i, confirmedByRecheck: true })) : [] }));
const prState = { number: pr, state: 'OPEN', isDraft: false, labels: [], headRefOid: head };
const goodLocals = () => ({
  referral: { state: 'none' }, scope: 'present', claim: { claimed: false }, pause: { paused: false },
  sameHead: { spent: false }, rounds: { attempts: 0, cap: 2 },
});
const build = (over = {}) => buildEligibilityFacts({
  pr: prState, comments: [], commentsComplete: true, population: 'fix', locals: goodLocals(), ...over });

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

describe('redTeamFact', () => {
  it('no red-team comment at all is known none', () => {
    expect(redTeamFact([], pr, head)).toEqual({ status: 'known', value: { state: 'none', resultId: null, sendBackResultId: null } });
  });
  it('a result only for an OLDER head is unread, never none or clear', () => {
    expect(redTeamFact([result(oldHead)], pr, head)).toEqual({ status: 'unread' });
  });
  it('a non-array or missing thread is unread', () => {
    expect(redTeamFact(undefined, pr, head)).toEqual({ status: 'unread' });
    expect(redTeamFact([], pr, 'short')).toEqual({ status: 'unread' });
  });
  it('a live result with no confirmed break is clear', () => {
    expect(redTeamFact([result(head, false)], pr, head).value.state).toBe('clear');
  });
  it('a live result with confirmed breaks and no gate record is pending, bound to the live result id', () => {
    const comments = [result(head)];
    const id = liveResultGateState(comments, pr, head).resultId;
    expect(redTeamFact(comments, pr, head)).toEqual({ status: 'known', value: { state: 'pending', resultId: id, sendBackResultId: null } });
  });
  it('a round-cap gate record on the live result is held', () => {
    const comments = [result(head)];
    const id = liveResultGateState(comments, pr, head).resultId;
    comments.push(bot(`${redTeamGateMarker(pr, head, 'round-cap', id)}\ncap`));
    expect(redTeamFact(comments, pr, head).value).toMatchObject({ state: 'held', resultId: id });
  });
  it('a sent-back gate record on the live result is a send-back bound to that result id', () => {
    const comments = [result(head)];
    const id = liveResultGateState(comments, pr, head).resultId;
    comments.push(bot(`${redTeamGateMarker(pr, head, 'sent-back', id)}\nsent`));
    expect(redTeamFact(comments, pr, head).value).toEqual({ state: 'send-back', resultId: id, sendBackResultId: id });
  });
  it('a send-back recorded for an older result id is not bound to the live one', () => {
    const comments = [result(head)];
    comments.push(bot(`${redTeamGateMarker(pr, head, 'sent-back', 'f'.repeat(16))}\nsent`));
    const v = redTeamFact(comments, pr, head);
    expect(v.status === 'unread' || v.value.state !== 'send-back' || v.value.sendBackResultId !== v.value.resultId).toBe(true);
    expect(eligibility({ ...prState, commentsComplete: true }, build({ comments })).dispatch).toBeUndefined();
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

describe('redTeamFact audit closures', () => {
  it('an operator-block record on the live result is blocked even with no confirmed finding', () => {
    const comments = [result(head, false)];
    const id = liveResultGateState(comments, pr, head).resultId;
    comments.push({ author: { login: 'chalbert', type: 'User' }, body: `${redTeamGateMarker(pr, head, 'operator-block', id)}\nblock` });
    expect(redTeamFact(comments, pr, head).value?.state ?? 'unread').not.toBe('clear');
  });
  it('a malformed finding line makes the result unread, not clear', () => {
    const good = result(head, false);
    const bad = bot(`${good.body}\n1. [**confirmed**] malformed finding line without a category`);
    expect(redTeamFact([bad], pr, head)).toEqual({ status: 'unread' });
  });
});
