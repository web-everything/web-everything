/** @file The review-hold reconcile sweep (#x01u7az) — drops a stray review:pending beside a live review:human,
 *  and a stray advisory:* left behind once review:human is gone. No `gh`. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { needsReviewHoldCleanup, planReviewHoldCleanup, sweepReviewHoldLabels } from '../review-hold-reconcile.mjs';
import { _resetAcceptCarryMemo } from '../accept-carry-sweep.mjs';

// The REAL #4535 measurement (card xu7kxtt): a cleared-human accept on an older head, the merge queue moved the head, the drain re-parked.
const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../lib/__tests__/fixtures/accept-carry-forward-4535.json'), 'utf8'));

const pr = (number, names) => ({ number, labels: names.map((name) => ({ name })) });

function provider({ readPrState } = {}) {
  const calls = { set: [], currentRepo: 0, readPrState: [], postComment: [] };
  return {
    calls,
    setLabels: (repo, number, spec) => { calls.set.push({ repo, number, spec }); },
    currentRepo: () => { calls.currentRepo += 1; return 'o/n'; },
    readPrState: (repo, number) => {
      calls.readPrState.push({ repo, number });
      if (typeof readPrState === 'function') return readPrState(repo, number);
      throw new Error('readPrState not stubbed for this test');
    },
    postComment: (repo, number, body) => { calls.postComment.push({ repo, number, body }); },
  };
}

describe('planReviewHoldCleanup', () => {
  it('does NOT flag review:changes beside review:human — a send-back under a human hold is designed (#3657)', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:human', 'review:changes'] }))
      .toEqual({ remove: [] });
    expect(needsReviewHoldCleanup(pr(1, ['review:human', 'review:changes']))).toBe(false);
  });

  it('still flags accepted+human when review:changes also rides along', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:accepted', 'review:human', 'review:changes'] }))
      .toEqual({ remove: [], flagged: ['review:accepted', 'review:human'] });
  });

  it('cleans pending beside human+changes without flagging or removing the send-back', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:human', 'review:changes', 'review:pending'] }))
      .toEqual({ remove: ['review:pending'] });
  });

  it('still flags accepted+changes without a human hold', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:accepted', 'review:changes'] }))
      .toEqual({ remove: [], flagged: ['review:accepted', 'review:changes'] });
  });

  // #x01u7az — LIVE, PR #2549 (2026-09-24): review:pending added by a mechanical rearm on top of a still-live
  // review:human, never cleared. At most one review:* hold at a time.
  it('drops a stray review:pending that coexists with review:human', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'review:pending' }] }))
      .toEqual({ remove: ['review:pending'] });
  });

  it('leaves review:pending alone when review:human is absent (an ordinary parked PR)', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:pending' }] })).toEqual({ remove: [] });
  });

  it('leaves review:human alone when review:pending is absent (an ordinary gate-self PR)', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }] })).toEqual({ remove: [] });
  });

  // #x01u7az — LIVE, PR #2578 (2026-09-24): advisory:accepted stamped while review:human, review:human later
  // cleared via clear-human, the advisory label left behind describing a gate that no longer exists.
  it('drops advisory:accepted once review:human is gone', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'advisory:accepted' }] }))
      .toEqual({ remove: ['advisory:accepted'] });
  });

  it('drops advisory:changes once review:human is gone', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'advisory:changes' }] }))
      .toEqual({ remove: ['advisory:changes'] });
  });

  it('leaves an advisory label alone while review:human is still live — it still means something', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'advisory:accepted' }] }))
      .toEqual({ remove: [] });
  });

  it('both invariants can fire together on one PR, additively', () => {
    // Not the #2549/#2578 shape (that would require human present for one check and absent for the other on
    // the SAME read) — a PR with a stray pending AND no human but a stray advisory is two independent strays.
    expect(planReviewHoldCleanup({
      currentLabels: [{ name: 'review:pending' }, { name: 'advisory:changes' }, { name: 'checking' }],
    })).toEqual({ remove: ['advisory:changes'] }); // no review:human present → the pending check does not fire
  });

  it('a clean PR (no contradiction) removes nothing', () => {
    expect(planReviewHoldCleanup({ currentLabels: [{ name: 'review:human' }, { name: 'review-round:2' }] }))
      .toEqual({ remove: [] });
    expect(planReviewHoldCleanup({ currentLabels: [] })).toEqual({ remove: [] });
  });

  it('tolerates bare-string label arrays, not just {name} objects', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:human', 'review:pending'] }))
      .toEqual({ remove: ['review:pending'] });
  });

  // #2766/#2767 (2026-09-26) — the mutual-exclusivity bug this sweep PREDATES: an unattended review loop
  // recorded review:accepted; the anti-test-gaming gate then parked review:human without removing it. This
  // sweep FLAGS the pair rather than resolving it (point 3's own comment says why: a label-only read cannot
  // tell a genuine human clearance from a bare superseded agent one, and #x9xqexm forbids guessing).
  it('FLAGS (never removes) a co-present review:accepted + review:human — #2766/#2767\'s real label state', () => {
    const live2767 = ['review:accepted', 'review:human', 'review-round:1', 'review:awaiting-advisory'];
    expect(planReviewHoldCleanup({ currentLabels: live2767 })).toEqual({ remove: [], flagged: ['review:accepted', 'review:human'] });
  });

  it('does NOT re-flag the human+pending pair point (1) already resolves — that is #2549, not #2766/#2767', () => {
    expect(planReviewHoldCleanup({ currentLabels: ['review:human', 'review:pending'] }))
      .toEqual({ remove: ['review:pending'] }); // no `flagged` key at all — the resolved pair is not a contradiction
  });

  it('flags accepted+human even alongside the OTHER two independent strays, additively', () => {
    expect(planReviewHoldCleanup({
      currentLabels: ['review:accepted', 'review:human', 'review:pending', 'advisory:accepted'],
    })).toEqual({ remove: ['review:pending'], flagged: ['review:accepted', 'review:human'] });
  });
});

describe('needsReviewHoldCleanup', () => {
  it('is true exactly when planReviewHoldCleanup would remove something', () => {
    expect(needsReviewHoldCleanup(pr(1, ['review:human', 'review:pending']))).toBe(true);
    expect(needsReviewHoldCleanup(pr(2, ['review:human']))).toBe(false);
    expect(needsReviewHoldCleanup(pr(3, []))).toBe(false);
  });

  it('is also true when the PR is only FLAGGED (nothing to remove) — #2766/#2767', () => {
    expect(needsReviewHoldCleanup(pr(2767, ['review:accepted', 'review:human']))).toBe(true);
  });
});

describe('sweepReviewHoldLabels', () => {
  it('skips a PR carrying review:human + review:changes — no entry, no readPrState call', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(3657, ['review:human', 'review:changes'])],
    });
    expect(results).toEqual([]);
    expect(p.calls.readPrState).toEqual([]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('keeps the send-back quiet over 100 sweeps while accepted+human still fails closed on fetch errors', () => {
    const p = provider(); // readPrState throws: no flagged label may be removed on this error path
    for (let tick = 0; tick < 100; tick += 1) {
      expect(sweepReviewHoldLabels({
        repo: 'o/n', provider: p,
        listPrs: () => [
          pr(3657, ['review:human', 'review:changes']),
          pr(2767, ['review:accepted', 'review:human', 'review:changes']),
        ],
      })).toEqual([{
        num: 2767, flagged: ['review:accepted', 'review:human'], flagReason: 'fetch-unavailable',
        fetchError: 'readPrState not stubbed for this test',
      }]);
    }
    expect(p.calls.readPrState).toEqual(Array.from({ length: 100 }, () => ({ repo: 'o/n', number: 2767 })));
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('drops the stray review:pending from a PR that also carries review:human (PR #2549 shape)', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending', 'review-round:5', 'advisory:changes'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 2549, spec: { remove: ['review:pending'] } }]);
  });

  it('drops the stale advisory:accepted from a PR whose review:human was already cleared (PR #2578 shape)', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2578, ['review:pending', 'checking', 'review-round:3', 'review-status:review-stalled', 'advisory:accepted'])],
    });
    expect(results).toEqual([{ num: 2578, remove: ['advisory:accepted'] }]);
  });

  it('leaves a clean PR (PR #2582 shape — review:human alone, no advisory yet) untouched', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2582, ['review:human', 'review-status:reviewing', 'review-round:1'])],
    });
    expect(results).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });

  // #2766/#2767 shapes below all carry the SAME real label set observed live 2026-09-26.
  const LIVE_LABELS = ['review:accepted', 'review:human', 'review-round:1', 'review:awaiting-advisory'];
  const bot = { login: 'web-everything' };
  const LIVE_2767_COMMENTS = [
    { body: '<!-- drain-park-reason -->\nheld — a review hold (review:pending) stands', author: bot },
    { body: '✅ review — accepted\n\nRecorded by agent (unattended review-loop)', author: bot },
    { body: '<!-- drain-park-reason -->\ntest-gaming suspected', author: bot },
  ];
  const LIVE_2767_HEAD = '8b8b1a510e5aa3db7bb1fc070040bca5b7c4dda5';

  it('FLAGS (never heals) when the readPrState fetch itself fails — fail closed toward NOT deleting', () => {
    const p = provider(); // no readPrState stub → throws
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{
      num: 2767, flagged: ['review:accepted', 'review:human'], flagReason: 'fetch-unavailable',
      fetchError: 'readPrState not stubbed for this test',
    }]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('FLAGS (never heals) when the PR\'s own comments prove a GENUINE current human clearance', () => {
    const p = provider({ readPrState: () => ({ headRefOid: 'aaa1111', comments: [{ body: '<!-- reviewed-sha: aaa1111 -->\n<!-- cleared-human: Ada -->', author: bot }] }) });
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, flagged: ['review:accepted', 'review:human'], flagReason: 'genuine-clearance' }]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('HEALS #2767\'s real (pre-fix) label + comment state — removes review:accepted, posts a comment, never touches review:human', () => {
    const p = provider({ readPrState: () => ({ headRefOid: LIVE_2767_HEAD, comments: LIVE_2767_COMMENTS }) });
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, healed: ['review:accepted'], commentPosted: true }]);
    expect(p.calls.set).toEqual([{ repo: 'web-everything/web-everything', number: 2767, spec: { remove: ['review:accepted'] } }]);
    expect(p.calls.postComment).toHaveLength(1);
    expect(p.calls.postComment[0].body).toContain('review:accepted` removed');
    expect(p.calls.postComment[0].body).toContain('review:human` remains');
    // COMMENT FIRST, then the label swap (the safer order for a removal — see the sweep's own comment).
    expect(p.calls.postComment[0]).toBeDefined();
  });

  it('HEALS #2766 too — the identical real shape, a different PR', () => {
    const p = provider({ readPrState: () => ({ headRefOid: 'abbe08beacae462f98d6caf654d3ce7867c92801', comments: LIVE_2767_COMMENTS }) });
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2766, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2766, healed: ['review:accepted'], commentPosted: true }]);
  });

  it('dry-run computes the heal but never posts the comment or calls setLabels', () => {
    const p = provider({ readPrState: () => ({ headRefOid: LIVE_2767_HEAD, comments: LIVE_2767_COMMENTS }) });
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p, dryRun: true,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, healed: ['review:accepted'] }]); // no commentPosted — nothing was posted
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('a postComment failure is captured on the entry but the label removal still proceeds', () => {
    const p = provider({ readPrState: () => ({ headRefOid: LIVE_2767_HEAD, comments: LIVE_2767_COMMENTS }) });
    p.postComment = () => { throw new Error('gh comment boom'); };
    const results = sweepReviewHoldLabels({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, healed: ['review:accepted'], error: 'gh comment boom' }]);
    // The removal still happened despite the comment failing — losing the explanation is bad, losing the fix is worse.
    expect(p.calls.set).toEqual([{ repo: 'web-everything/web-everything', number: 2767, spec: { remove: ['review:accepted'] } }]);
  });

  it('dry-run reports the plan and never calls setLabels', () => {
    const p = provider();
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p, dryRun: true,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([]);
  });

  it('a setLabels failure is captured on the entry, not thrown — one bad PR must not abort the sweep', () => {
    const p = provider();
    p.setLabels = () => { throw new Error('gh boom'); };
    const results = sweepReviewHoldLabels({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'], error: 'gh boom' }]);
  });

  it('resolves --repo lazily from the provider only when a write is about to happen', () => {
    const p = provider();
    sweepReviewHoldLabels({ repo: null, provider: p, listPrs: () => [pr(1, ['review:human', 'review:pending'])] });
    expect(p.calls.currentRepo).toBe(1);
  });

  // Card xu7kxtt (#5472), PR #4631 round 5: the call from this sweep into `sweepAcceptCarry` was only exercised by tests that call
  // `planAcceptCarry` / `sweepAcceptCarry` directly. Deleting the block, dropping `prs` / `repo`, or breaking the `acceptCarry` seam left
  // every one of them green while the daemon silently stopped carrying an operator clearance past a mechanical review:human re-hold.
  describe('accept carry-forward leg (card xu7kxtt)', () => {
    const carryPr = () => ({
      number: fx.pr, labels: fx.labelsAfterRepark.map((name) => ({ name })), headRefOid: fx.newHead, comments: fx.comments,
    });
    // The setting is read from env first; pin it so a host `WE_ACCEPT_CARRY_FORWARD=off` cannot silently skip the leg under test.
    beforeEach(() => { vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on'); _resetAcceptCarryMemo(); });
    afterEach(() => { vi.unstubAllEnvs(); _resetAcceptCarryMemo(); });

    it('hands the listed #4535-shaped PR to the injected restamp runner and reports one carried entry', () => {
      const calls = [];
      const results = sweepReviewHoldLabels({
        repo: fx.repo, provider: provider(), listPrs: () => [carryPr()],
        acceptCarry: (c) => { calls.push(c); return { ok: true, detail: 'ok' }; },
      });
      // `repo` and the planned head / accepted head travel with the call: dropping any of them reddens this.
      expect(calls).toEqual([{ repo: fx.repo, num: fx.pr, head: fx.newHead, from: fx.acceptedHead }]);
      expect(results.filter((r) => r.carry)).toEqual([{ num: fx.pr, carry: 'carried', detail: 'ok' }]);
    });

    it('--dry-run reports would-try and never runs the restamp', () => {
      const results = sweepReviewHoldLabels({
        repo: fx.repo, provider: provider(), listPrs: () => [carryPr()], dryRun: true,
        acceptCarry: () => { throw new Error('dry-run must not run the restamp'); },
      });
      expect(results.filter((r) => r.carry)).toEqual([
        { num: fx.pr, carry: 'would-try', detail: `${fx.acceptedHead.slice(0, 9)} → ${fx.newHead.slice(0, 9)}` },
      ]);
    });

    it('a restamp runner that throws is a retry entry for that PR — it does not fail the sweep or hide the PR', () => {
      const results = sweepReviewHoldLabels({
        repo: fx.repo, provider: provider(), listPrs: () => [carryPr()],
        acceptCarry: () => { throw new Error('spawn blew up\nstack line'); },
      });
      expect(results.filter((r) => r.carry)).toEqual([{ num: fx.pr, carry: 'retry', detail: 'spawn blew up' }]);
    });

    it('a failure inside the carry leg itself becomes one sweep-failed entry and the later legs still run', () => {
      const boom = { number: 9, labels: [{ name: 'review:human' }], headRefOid: fx.newHead, get comments() { throw new Error('comments unreadable\nstack line'); } };
      const results = sweepReviewHoldLabels({
        repo: fx.repo, provider: provider(), listPrs: () => [boom], acceptCarry: () => { throw new Error('unreachable'); },
      });
      expect(results.filter((r) => r.carry)).toEqual([{ num: 0, carry: 'sweep-failed', error: 'comments unreadable' }]);
      // Containment: the sweep returned (did not throw) and a sibling leg's own failure entry is still reported after the carry one.
      expect(results.some((r) => r.autoBlock || r.ruling)).toBe(true);
    });
  });
});
