/** @file The review-hold reconcile sweep (#x01u7az) — drops a stray review:pending beside a live review:human,
 *  and a stray advisory:* left behind once review:human is gone. No `gh`. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  needsReviewHoldCleanup, planReviewHoldCleanup, sweepReviewHoldLabels, _resetStrandedCheckMemo, STRANDED_BACKOFF_MS, STRANDED_RECHECK_MS,
} from '../review-hold-reconcile.mjs';
import { _resetAcceptCarryMemo } from '../accept-carry-sweep.mjs';
import { sweepLabelStateReconcile } from '../label-state-reconcile.mjs';
import { resolveAcceptCarryForward } from '../../lib/accept-carry-forward.mjs';
import { buildNumberingRestampBody, restampAfterNumbering, _resetNumberingRestampMemo } from '../../lib/numbering-carry.mjs';

// The REAL #4535 measurement (card xu7kxtt): a cleared-human accept on an older head, the merge queue moved the head, the drain re-parked.
const fx = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../lib/__tests__/fixtures/accept-carry-forward-4535.json'), 'utf8'));

const pr = (number, names) => ({ number, labels: names.map((name) => ({ name })) });

it('composes label-state reconciliation with live readers, provider and dryRun', () => {
  const head = 'a'.repeat(40);
  const snapshot = { number: 5973, headRefOid: head, labels: ['red-team:blocked'] };
  const live = { ...snapshot, state: 'OPEN' };
  const p = { ...provider(), ensureLabel: vi.fn() };
  const emit = vi.fn();
  const options = { repo: 'o/n', provider: p, dryRun: true, listPrs: () => [snapshot],
    readPr: () => live, readComments: () => [{ author: { login: 'web-everything' },
      body: `<!-- we:red-team-advisory pr=5973 rev=${head} -->\nACCEPTS` }],
    numberingRestamp: () => null, exec: () => 'git@github.com:o/n.git', settings: { referralDefault: 'operator' },
    delegatedClearance: { prs: [] }, labelState: { readReviews: () => [], readRedTeam: () => null, emit } };
  const out = sweepReviewHoldLabels(options);
  expect(out).toContainEqual(expect.objectContaining({ num: 5973, dryRun: true,
    labelsReconciled: expect.objectContaining({ to: ['red-team:clear'] }) }));
  expect(out).toContainEqual(sweepLabelStateReconcile({ ...options, prs: [snapshot], ...options.labelState })[0]);
  expect(p.calls.set).toEqual([]);
  expect(emit).not.toHaveBeenCalled();
});

// Existing cleanup fixtures describe the live PR explicitly through their listed labels.
// The later boundary regressions supply independently stale snapshots and fresh records.
function sweepFixture(opts) {
  const prs = opts.listPrs();
  opts.provider.fixturePrs = prs;
  return sweepReviewHoldLabels({ exec: () => 'git@github.com:o/n.git', numberingRestamp: () => null, ...opts, settings: { referralDefault: 'operator' },
    readComments: opts.provider.readComments,
    readPr: ({ number }) => ({ number, state: 'OPEN', headRefOid: 'a'.repeat(40), labels: [], comments: [] }) });
}
function provider({ readPrState, failRead = false } = {}) {
  const calls = { set: [], currentRepo: 0, readPrState: [], postComment: [] };
  const states = new Map();
  const p = {
    calls,
    fixturePrs: [],
    readComments: (number) => states.get(number)?.comments ?? [],
    setLabels: (repo, number, spec) => { calls.set.push({ repo, number, spec }); },
    currentRepo: () => { calls.currentRepo += 1; return 'o/n'; },
    readPrState: (repo, number) => {
      calls.readPrState.push({ repo, number });
      if (failRead) throw new Error('readPrState not stubbed for this test');
      const state = { state: 'OPEN', headRefOid: 'a'.repeat(40), comments: [],
        ...p.fixturePrs.find((pr) => pr.number === number), ...(readPrState?.(repo, number) ?? {}) };
      states.set(number, state);
      return state;
    },
    postComment: (repo, number, body) => { calls.postComment.push({ repo, number, body }); },
  };
  return p;
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
    const results = sweepFixture({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(3657, ['review:human', 'review:changes'])],
    });
    expect(results).toEqual([]);
    expect(p.calls.readPrState).toEqual([]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('keeps the send-back quiet over 100 sweeps while accepted+human still fails closed on fetch errors', () => {
    const p = provider({ failRead: true }); // readPrState throws: no flagged label may be removed on this error path
    for (let tick = 0; tick < 100; tick += 1) {
      expect(sweepFixture({
        repo: 'o/n', provider: p,
        listPrs: () => [
          pr(3657, ['review:human', 'review:changes']),
          pr(2767, ['review:accepted', 'review:human', 'review:changes']),
        ],
      })).toEqual([{
        num: 2767, skipped: 'live re-read failed: readPrState not stubbed for this test',
      }]);
    }
    expect(p.calls.readPrState).toEqual(Array.from({ length: 100 }, () => ({ repo: 'o/n', number: 2767 })));
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('drops the stray review:pending from a PR that also carries review:human (PR #2549 shape)', () => {
    const p = provider();
    const results = sweepFixture({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending', 'review-round:5', 'advisory:changes'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([{ repo: 'o/n', number: 2549, spec: { remove: ['review:pending'] } }]);
  });

  it('drops the stale advisory:accepted from a PR whose review:human was already cleared (PR #2578 shape)', () => {
    const p = provider();
    const results = sweepFixture({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2578, ['review:pending', 'checking', 'review-round:3', 'review-status:review-stalled', 'advisory:accepted'])],
    });
    expect(results).toEqual([{ num: 2578, remove: ['advisory:accepted'] }]);
  });

  it('leaves a clean PR (PR #2582 shape — review:human alone, no advisory yet) untouched', () => {
    const p = provider();
    const results = sweepFixture({
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

  it('skips when the readPrState fetch itself fails — fail closed toward NOT deleting', () => {
    const p = provider({ failRead: true }); // injected read failure
    const results = sweepFixture({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{
      num: 2767, skipped: 'live re-read failed: readPrState not stubbed for this test',
    }]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('FLAGS (never heals) when the PR\'s own comments prove a GENUINE current human clearance', () => {
    const p = provider({ readPrState: () => ({ headRefOid: 'aaa1111', comments: [{ body: '<!-- reviewed-sha: aaa1111 -->\n<!-- cleared-human: Ada -->', author: bot }] }) });
    const results = sweepFixture({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, flagged: ['review:accepted', 'review:human'], flagReason: 'genuine-clearance' }]);
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });

  it('HEALS #2767\'s real (pre-fix) label + comment state — removes review:accepted, posts a comment, never touches review:human', () => {
    const p = provider({ readPrState: () => ({ headRefOid: LIVE_2767_HEAD, comments: LIVE_2767_COMMENTS }) });
    const results = sweepFixture({
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
    const results = sweepFixture({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2766, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2766, healed: ['review:accepted'], commentPosted: true }]);
  });

  it('dry-run computes the heal but never posts the comment or calls setLabels', () => {
    const p = provider({ readPrState: () => ({ headRefOid: LIVE_2767_HEAD, comments: LIVE_2767_COMMENTS }) });
    const results = sweepFixture({
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
    const results = sweepFixture({
      repo: 'web-everything/web-everything', provider: p,
      listPrs: () => [pr(2767, LIVE_LABELS)],
    });
    expect(results).toEqual([{ num: 2767, healed: ['review:accepted'], error: 'gh comment boom' }]);
    // The removal still happened despite the comment failing — losing the explanation is bad, losing the fix is worse.
    expect(p.calls.set).toEqual([{ repo: 'web-everything/web-everything', number: 2767, spec: { remove: ['review:accepted'] } }]);
  });

  it('dry-run reports the plan and never calls setLabels', () => {
    const p = provider();
    const results = sweepFixture({
      repo: 'o/n', provider: p, dryRun: true,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'] }]);
    expect(p.calls.set).toEqual([]);
  });

  it('a setLabels failure is captured on the entry, not thrown — one bad PR must not abort the sweep', () => {
    const p = provider();
    p.setLabels = () => { throw new Error('gh boom'); };
    const results = sweepFixture({
      repo: 'o/n', provider: p,
      listPrs: () => [pr(2549, ['review:human', 'review:pending'])],
    });
    expect(results).toEqual([{ num: 2549, remove: ['review:pending'], error: 'gh boom' }]);
  });

  it('resolves --repo lazily from the provider only when a write is about to happen', () => {
    const p = provider();
    sweepFixture({ repo: null, provider: p, listPrs: () => [pr(1, ['review:human', 'review:pending'])] });
    expect(p.calls.currentRepo).toBe(1);
  });

  // Card xu7kxtt (#5472), PR #4631 round 5: the call from this sweep into `sweepAcceptCarry` was only exercised by tests that call
  // `planAcceptCarry` / `sweepAcceptCarry` directly. Deleting the block, dropping `prs` / `repo`, or breaking the `acceptCarry` seam left
  // every one of them green while the daemon silently stopped carrying an operator clearance past a mechanical review:human re-hold.
  describe('accept carry-forward leg (card xu7kxtt)', () => {
    // A repo with no provisioned checkout, NOT the fixture's real slug: if the `acceptCarry` seam ever breaks, the default runner
    // must stop at "no checkout provisioned" rather than spawn a real `review-set-label --to=restamp` against GitHub.
    const REPO = 'o/n';
    // PR #4631 (operator ruling a): the drain now parks the #4535 shape with its OWN `review:held-mechanical`, the only hold
    // the carry may lift; the live labels' `review:human` is swapped for it (a review:human PR is never planned).
    const carryPr = () => ({
      number: fx.pr, labels: fx.labelsAfterRepark.map((name) => ({ name: name === 'review:human' ? 'review:held-mechanical' : name })),
      headRefOid: fx.newHead, comments: fx.comments,
    });
    // The setting is read from env first; pin it so a host `WE_ACCEPT_CARRY_FORWARD=off` cannot silently skip the leg under test.
    beforeEach(() => { vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on'); _resetAcceptCarryMemo(); });
    afterEach(() => { vi.unstubAllEnvs(); _resetAcceptCarryMemo(); });

    it('hands the listed #4535-shaped PR to the injected restamp runner and reports one carried entry', () => {
      const calls = [];
      const results = sweepFixture({
        repo: REPO, provider: provider(), listPrs: () => [carryPr()],
        acceptCarry: (c) => { calls.push(c); return { ok: true, detail: 'ok' }; },
      });
      // `repo` and the planned head / accepted head travel with the call: dropping any of them reddens this.
      expect(calls).toEqual([{ repo: REPO, num: fx.pr, head: fx.newHead, from: fx.acceptedHead }]);
      expect(results.filter((r) => r.carry)).toEqual([{ num: fx.pr, carry: 'carried', detail: 'ok' }]);
    });

    it('--dry-run reports would-try and never runs the restamp', () => {
      const results = sweepFixture({
        repo: REPO, provider: provider(), listPrs: () => [carryPr()], dryRun: true,
        acceptCarry: () => { throw new Error('dry-run must not run the restamp'); },
      });
      expect(results.filter((r) => r.carry)).toEqual([
        { num: fx.pr, carry: 'would-try', detail: `${fx.acceptedHead.slice(0, 9)} → ${fx.newHead.slice(0, 9)}` },
      ]);
    });

    it('a restamp runner that throws is a retry entry for that PR — it does not fail the sweep or hide the PR', () => {
      const results = sweepFixture({
        repo: REPO, provider: provider(), listPrs: () => [carryPr()],
        acceptCarry: () => { throw new Error('spawn blew up\nstack line'); },
      });
      expect(results.filter((r) => r.carry)).toEqual([{ num: fx.pr, carry: 'retry', detail: 'spawn blew up' }]);
    });

    it('a failure inside the carry leg itself becomes one sweep-failed entry and the later legs still run', () => {
      const boom = { number: 9, labels: [{ name: 'review:held-mechanical' }], headRefOid: fx.newHead, get comments() { throw new Error('comments unreadable\nstack line'); } };
      const results = sweepFixture({
        repo: REPO, provider: provider(), listPrs: () => [boom], acceptCarry: () => { throw new Error('unreachable'); },
      });
      // Containment: the sweep RETURNED (the throw did not escape) and reports the failure as one entry for the carry leg.
      expect(results.filter((r) => r.carry)).toEqual([{ num: 0, carry: 'sweep-failed', error: 'comments unreadable' }]);
    });
  });
});


describe('fresh complete review-hold decisions (#5955)', () => {
  const labels = ['review:human', 'review:accepted'];
  const head = 'a'.repeat(40);
  const filler = () => ({ body: 'discussion', author: { login: 'stranger' } });
  const clearance = { body: `<!-- reviewed-sha: ${head} -->\n<!-- cleared-human: Ada -->`, author: { login: 'web-everything' } };
  const live = (extra = {}) => ({ state: 'OPEN', labels, headRefOid: head, comments: [], ...extra });
  const run = ({ snapshot = { number: 7, labels, comments: [] }, state = live(), comments = [], dryRun = false } = {}) => {
    const p = provider({ readPrState: () => state });
    const readComments = vi.fn(() => { if (comments instanceof Error) throw comments; return comments; });
    const out = sweepReviewHoldLabels({ repo: 'o/n', listPrs: () => [snapshot], provider: p, readComments,
      readPr: () => live({ labels: [], comments: [] }), settings: { referralDefault: 'operator' }, dryRun });
    return { p, out, readComments };
  };
  it('a trusted clearance at comment 120 protects acceptance beyond the first 100', () => {
    const comments = [...Array.from({ length: 119 }, filler), clearance];
    const { p, out, readComments } = run({ snapshot: { number: 7, labels, comments: comments.slice(0, 100) },
      state: live({ comments: comments.slice(0, 100) }), comments });
    expect(p.calls.set).toEqual([]);
    expect(out).toContainEqual({ num: 7, flagged: ['review:accepted', 'review:human'], flagReason: 'genuine-clearance' });
    expect(readComments).toHaveBeenCalledWith(7, { repo: 'o/n' });
  });
  it('recomputes ordinary cleanup from fresh labels instead of removing a now-valid advisory', () => {
    const { p, out } = run({ snapshot: { number: 7, labels: ['advisory:accepted'] },
      state: live({ labels: ['review:human', 'advisory:accepted'] }) });
    expect(p.calls.set).toEqual([]);
    expect(out).toEqual([]);
  });
  it.each([0, 12, 99, 100])('always reads a full thread with %i cached comments', (count) => {
    _resetStrandedCheckMemo();
    const { p, readComments } = run({ snapshot: { number: 7, labels, comments: Array.from({ length: count }, filler) }, comments: [...Array.from({ length: 99 }, filler), clearance] });
    // A capped listing may hide a numbering re-stamp record, so the withdrawal leg reads the thread live as well.
    expect(readComments).toHaveBeenCalledTimes(count >= 100 ? 2 : 1);
    expect(p.calls.set).toEqual([]);
  });
  it.each([
    ['forged', { ...clearance, author: { login: 'stranger' } }],
    ['old-head', { ...clearance, body: clearance.body.replace(head, 'b'.repeat(40)) }],
  ])('does not trust a %s clearance at comment 120', (_, marker) => {
    const { p, out } = run({ comments: [...Array.from({ length: 119 }, filler), marker] });
    expect(out[0].healed).toEqual(['review:accepted']);
    expect(p.calls.set[0].spec).toEqual({ remove: ['review:accepted'] });
  });
  it.each([
    ['closed', live({ state: 'CLOSED' }), []],
    ['missing state', live({ state: undefined }), []],
    ['missing head', live({ headRefOid: '' }), []],
    ['missing labels', live({ labels: undefined }), []],
    ['malformed label', live({ labels: [{}] }), []],
    ['non-array thread', live(), null],
    ['later page failure', live(), new Error('page 2 failed')],
  ])('refuses all cleanup and healing on %s', (_, state, comments) => {
    const { p, out } = run({ snapshot: { number: 7, labels: [...labels, 'review:pending'] }, state, comments });
    expect(out[0]).toMatchObject({ num: 7, skipped: expect.stringContaining('live re-read failed') });
    expect(p.calls.set).toEqual([]);
    expect(p.calls.postComment).toEqual([]);
  });
  it('does not read cleanup metadata or comments without a nominated candidate', () => {
    const { p, readComments } = run({ snapshot: { number: 7, labels: ['review:human'] } });
    expect(p.calls.readPrState).toEqual([]);
    expect(readComments).not.toHaveBeenCalled();
  });
  it('filters heal removals using the live labels, including a new head and a removed acceptance', () => {
    const { p, out } = run({ state: live({ labels: ['review:human'], headRefOid: 'b'.repeat(40) }) });
    expect(out).toEqual([]);
    expect(p.calls.set).toEqual([]);
  });
  it.each(['src/app.mjs', 'docs/readme.md', 'config.json', 'data/rows.json'])('reads before writing regardless of PR files: %s', (file) => {
    const trace = [];
    const snapshot = { number: 7, labels, files: [{ path: file }], comments: [] };
    const p = { currentRepo: vi.fn(() => 'o/n'),
      readPrState: (repo, num) => { trace.push(['state', repo, num]); return live(); },
      postComment: (repo, num) => trace.push(['comment', repo, num]),
      setLabels: (repo, num) => trace.push(['labels', repo, num]) };
    const readComments = (num, { repo }) => { trace.push(['thread', repo, num]); return []; };
    sweepReviewHoldLabels({ provider: p, readComments, listPrs: () => [snapshot],
      readPr: () => live({ labels: [] }), settings: { referralDefault: 'operator' } });
    expect(trace).toEqual(['state', 'thread', 'comment', 'labels'].map((step) => [step, 'o/n', 7]));
    expect(p.currentRepo).toHaveBeenCalledOnce();
  });
  it('dry-run reads and plans the same healing but makes no writes', () => {
    const real = run();
    const dry = run({ dryRun: true });
    expect(dry.out).toEqual(real.out.map(({ commentPosted, ...entry }) => entry));
    expect(dry.readComments).toHaveBeenCalledOnce();
    expect(dry.p.calls.set).toEqual([]);
    expect(dry.p.calls.postComment).toEqual([]);
  });
  it('isolates a failed PR and retries it next tick without changing snapshot objects', () => {
    const snapshots = [7, 8].map((number) => ({ number, labels, comments: [] }));
    const before = JSON.stringify(snapshots);
    let fail = true;
    const p = provider({ readPrState: () => live() });
    const readComments = (number) => { if (number === 7 && fail) throw new Error('page 2 failed'); return []; };
    const sweep = () => sweepReviewHoldLabels({ repo: 'o/n', provider: p, listPrs: () => snapshots, readComments,
      readPr: () => live({ labels: [] }), settings: { referralDefault: 'operator' } });
    expect(sweep()[0].skipped).toContain('page 2 failed');
    expect(p.calls.set.map((c) => c.number)).toEqual([8]);
    fail = false;
    expect(sweep().map((r) => r.num)).toEqual([7, 8]);
    expect(p.calls.set.map((c) => c.number)).toEqual([8, 7, 8]);
    expect(JSON.stringify(snapshots)).toBe(before);
  });
  it('the same PR number in another repository does not inherit clearance authority', () => {
    const writes = [];
    const p = { readPrState: () => live(), postComment: () => {}, setLabels: (repo, number) => writes.push([repo, number]) };
    const reads = [];
    for (const repo of ['o/cleared', 'o/uncleared']) {
      sweepReviewHoldLabels({ repo, provider: p, listPrs: () => [{ number: 7, labels }],
        readComments: (number, { repo: slug }) => { reads.push([slug, number]); return slug === 'o/cleared' ? [clearance] : []; },
        readPr: () => live({ labels: [] }), settings: { referralDefault: 'operator' } });
    }
    expect(reads).toEqual([['o/cleared', 7], ['o/uncleared', 7]]);
    expect(writes).toEqual([['o/uncleared', 7]]);
  });

  it('does not remove pending twice when cleanup and healing both apply', () => {
    const state = live({ labels: [...labels, 'review:pending'] });
    const real = run({ state });
    const dry = run({ state, dryRun: true });
    expect(real.p.calls.set.map((c) => c.spec.remove)).toEqual([['review:pending'], ['review:accepted']]);
    expect(dry.out).toEqual(real.out.map(({ commentPosted, ...entry }) => entry));
  });

});


describe('#5045 pending with a stale accept', () => {
  const head = '922a19a18cd6f25f6838b98b79127277247bd5bc';
  for (const current of [false, true]) it(current ? 'flags same-head acceptance' : 'posts evidence and removes only stale accepted', () => {
    const p = provider({ readPrState: () => ({ labels: ['review:pending', 'review:accepted'], headRefOid: head, comments: [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${current ? head : '9db3d19825465e7da28c4e179833e2c799bb94e4'} -->` }] }) });
    const results = sweepFixture({ listPrs: () => [pr(5045, ['review:pending', 'review:accepted'])], provider: p, repo: 'o/n' });
    const r = results.find((r) => r.num === 5045 && (r.healed || r.flagged));
    if (current) {
      expect(r.flagReason).toBe('accept-current');
      expect(p.calls.set).toEqual([]);
    } else {
      expect(r.healed).toEqual(['review:accepted']);
      expect(r.commentPosted).toBe(true);
      expect(p.calls.set[0].spec).toEqual({ remove: ['review:accepted'] });
      expect(p.calls.postComment[0].body).toContain('review:pending');
    }
  });
});

it('restamps numbering before the stale-accept heal and skips that heal', () => {
  const p = provider();
  const result = sweepFixture({ repo: 'o/n', provider: p,
    listPrs: () => [pr(5025, ['review:pending', 'review:accepted'])],
    exec: () => 'git@github.com:o/n.git', numberingRestamp: () => ({ action: 'restamped' }) });
  expect(result).toContainEqual({ num: 5025, numberingRestamp: 'restamped', detail: undefined });
  expect(p.calls.postComment).toEqual([]);
  expect(p.calls.set).toEqual([]);
});

it.each([false, true])('preserves the numbering carry kill switch with injected runner=%s', injected => {
  vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'off');
  try {
    const runner = vi.fn();
    const p = provider({ readPrState: () => ({ comments: [{ author: { login: 'chalbert' },
      body: `✅ review — accepted\n<!-- reviewed-sha: ${'b'.repeat(40)} -->` }] }) });
    p.readPrReviews = () => [];
    const result = sweepFixture({ repo: 'o/n', provider: p,
      listPrs: () => [pr(5025, ['review:pending'])], ...(injected ? { acceptCarry: runner } : {}),
      numberingRestamp: opts => {
        expect(opts.acceptCarry).toBe('off'); // the resolved setting, never the injected runner
        return restampAfterNumbering({ ...opts, enabled: true,
          prove: () => { throw Error('kill switch must prevent proof'); } });
      } });
    expect(result.some(r => r.numberingRestamp)).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});
describe('resolveAcceptCarryForward() is the only source of the hold-reconcile numbering carry setting', () => {
  const accepted = () => provider({ readPrState: () => ({ comments: [{ author: { login: 'chalbert' },
    body: `✅ review — accepted\n<!-- reviewed-sha: ${'b'.repeat(40)} -->` }] }) });
  const sweep = (env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    _resetNumberingRestampMemo();
    const p = accepted(); p.readPrReviews = () => [];
    const proof = vi.fn(() => ({ ok: true, reason: 'verified' }));
    const logs = [];
    const result = sweepFixture({ repo: 'o/n', provider: p, dryRun: true, listPrs: () => [pr(5025, ['review:pending'])], log: line => logs.push(line),
      numberingRestamp: opts => restampAfterNumbering({ ...opts, enabled: true, readNetDiff: () => null, prove: proof }) });
    return { proof, result, logs };
  };
  afterEach(() => { vi.unstubAllEnvs(); _resetNumberingRestampMemo(); });
  it.each(['true', 'false'])('acceptCarryForward=off disables the numbering carry whatever skipDrainMechanical says (%s)', skip => {
    const { proof, result } = sweep({ WE_ACCEPT_CARRY_FORWARD: 'off', WE_REVIEW_SKIP_DRAIN_MECHANICAL: skip });
    expect(proof).not.toHaveBeenCalled();
    expect(result.some(r => r.numberingRestamp)).toBe(false);
  });
  it.each(['true', 'false'])('acceptCarryForward=on carries whatever skipDrainMechanical says (%s), and logs the source', skip => {
    const { proof, result, logs } = sweep({ WE_ACCEPT_CARRY_FORWARD: 'on', WE_REVIEW_SKIP_DRAIN_MECHANICAL: skip });
    expect(proof).toHaveBeenCalledTimes(1);
    expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'would-restamp' }));
    expect(logs).toEqual(['  numbering carry: accept carry-forward on (source: env)']);
  });
});
it('keeps the injected restamp runner out of the numbering setting', () => {
  let options;
  sweepFixture({ repo: 'o/n', provider: provider(), listPrs: () => [pr(5025, ['review:pending'])],
    acceptCarry: vi.fn(), numberingRestamp: opts => { options = opts; return null; } });
  expect(options.acceptCarry).toBe(resolveAcceptCarryForward().value);
});

it('still proves and plans numbering carry with an injected accept runner', () => {
  vi.stubEnv('WE_ACCEPT_CARRY_FORWARD', 'on');
  _resetNumberingRestampMemo();
  try {
    const p = provider({ readPrState: () => ({ comments: [{ author: { login: 'chalbert' },
      body: `✅ review — accepted\n<!-- reviewed-sha: ${'b'.repeat(40)} -->` }] }) });
    p.readPrReviews = () => [];
    const proof = vi.fn(() => ({ ok: true, reason: 'verified' }));
    const result = sweepFixture({ repo: 'o/n', provider: p, dryRun: true,
      listPrs: () => [pr(5025, ['review:pending'])], acceptCarry: vi.fn(),
      numberingRestamp: opts => restampAfterNumbering({ ...opts, enabled: true, readNetDiff: () => null, prove: proof }) });
    expect(proof).toHaveBeenCalledTimes(1);
    expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'would-restamp' }));
  } finally { vi.unstubAllEnvs(); _resetNumberingRestampMemo(); }
});

it('keeps an unsatisfied mandatory referral held on the daemon numbering path', () => {
  _resetNumberingRestampMemo();
  const p = provider({ readPrState: () => ({ comments: [
    { author: { login: 'chalbert' }, body: '<!-- mandatory-referrals-v1: truncated -->' },
    { author: { login: 'chalbert' }, body: `✅ review — human cleared\n<!-- reviewed-sha: ${'b'.repeat(40)} -->\n<!-- cleared-human: chalbert -->` },
  ] }) });
  const result = sweepFixture({ repo: 'o/n', provider: p, listPrs: () => [pr(5025, ['review:pending'])],
    numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: true, acceptCarry: 'on',
      prove: () => { throw Error('unexpected proof'); } }) });
  expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'retry' }));
  expect(p.calls.postComment).toEqual([]);
  expect(p.calls.set).toEqual([]);
  _resetNumberingRestampMemo();
});

it('passes unreadable reviews as null and keeps numbering failures isolated per PR', () => {
  const p = provider();
  const seen = [];
  const result = sweepFixture({ repo: 'o/n', provider: p,
    listPrs: () => [pr(1, ['review:pending']), pr(2, ['review:pending'])],
    numberingRestamp: (opts) => {
      seen.push(opts);
      if (opts.pr === 1) throw Error('isolated failure');
      return { action: 'retry', reason: 'formal reviews unreadable' };
    } });
  expect(seen.map((o) => o.reviews)).toEqual([null, null]);
  expect(seen.every((o) => o.cwd === undefined)).toBe(true);
  expect(result).toContainEqual({ num: 1, numberingRestamp: 'error', detail: 'isolated failure' });
  expect(result).toContainEqual({ num: 2, numberingRestamp: 'retry', detail: 'formal reviews unreadable' });
});

it('re-reads the PR before posting, so an objection made during the numbering proof keeps the hold (red team #5233)', () => {
  _resetNumberingRestampMemo();
  const accept = { author: { login: 'chalbert' }, createdAt: '2026-10-12T10:00:00Z',
    body: `✅ review — human cleared\n<!-- reviewed-sha: ${'b'.repeat(40)} -->\n<!-- cleared-human: chalbert -->` };
  const objection = { author: { login: 'chalbert' }, body: 'Do not land this. I found a bug and am preparing findings.' };
  let proved = false;
  const p = provider({ readPrState: () => ({ comments: proved ? [accept, objection] : [accept] }) });
  p.readPrReviews = () => [];
  const result = sweepFixture({ repo: 'o/n', provider: p, listPrs: () => [pr(5025, ['review:pending'])],
    numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: true, acceptCarry: 'on', guardReferrals: () => {},
      readNetDiff: () => null, prove: () => { proved = true; return { ok: true, reason: 'verified' }; } }) });
  expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'held' }));
  expect(p.calls.readPrState).toHaveLength(2);
  expect(p.calls.postComment).toEqual([]);
  expect(p.calls.set).toEqual([]);
  _resetNumberingRestampMemo();
});

// Operator block (#5233, head 8265716f7): a re-stamp record written over a hold before it is withdrawn on any PR,
// whatever its labels — a changes verdict or a human park would otherwise keep the sweep away from it for good.
describe('numbering re-stamp withdrawal on label-held PRs', () => {
  const FROM = 'b'.repeat(40);
  const accept = { author: { login: 'chalbert' }, createdAt: '2026-10-12T10:00:00Z',
    body: `✅ review — human cleared\n<!-- reviewed-sha: ${FROM} -->\n<!-- cleared-human: chalbert -->` };
  const objection = { author: { login: 'chalbert' }, body: 'Do not land this. I found a bug and am preparing findings.' };
  const record = { author: { login: 'chalbert' }, id: 'IC_stranded', body: buildNumberingRestampBody({
    fromSha: FROM, toSha: 'a'.repeat(40), human: true, actor: 'chalbert', proofReason: 'verified', writer: 'review-daemon' }) };
  it.each([[['review:changes']], [['review:human']], [['review:pending', 'review:held-mechanical']]])(
    'reaches a stranded record under %j', (labels) => {
      const seen = [];
      const result = sweepFixture({ repo: 'o/n', provider: provider(),
        listPrs: () => [{ ...pr(5025, labels), comments: [accept, objection, record] }],
        numberingRestamp: (opts) => { seen.push(opts.pr); return { action: 'withdrawn', reason: 'withdrawn' }; } });
      expect(seen).toEqual([5025]);
      expect(result).toContainEqual({ num: 5025, numberingRestamp: 'withdrawn', detail: 'withdrawn' });
    });
  it('leaves a label-held PR with no stranded record alone', () => {
    // The listed record is read live once (formal reviews are not in the listing); with none, nothing is withdrawn.
    const p = provider();
    p.readPrReviews = () => [];
    p.editComment = vi.fn();
    const result = sweepFixture({ repo: 'o/n', provider: p,
      listPrs: () => [{ ...pr(5025, ['review:changes']), comments: [accept, record, objection] }],
      numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: false }) });
    expect(p.editComment).not.toHaveBeenCalled();
    expect(result).toEqual([]);
    _resetStrandedCheckMemo();
  });
  // Operator send-back (#5233): a failed withdrawal behind a hold the thread cannot show stays owed across sweeps.
  it('keeps reaching a record whose withdrawal failed, though the thread shows no hold against it', () => {
    _resetNumberingRestampMemo();
    const failing = { editComment: () => { throw Error('rate limited'); } };
    const first = restampAfterNumbering({ repo: 'o/n', pr: 5025, provider: failing, enabled: false,
      state: { labels: [{ name: 'review:pending' }], headRefOid: 'a'.repeat(40), comments: [accept, objection, record] } });
    expect(first).toMatchObject({ action: 'error', reason: 'withdrawal failed: rate limited' });
    const seen = [];
    const p = provider();
    p.editComment = vi.fn();
    const result = sweepFixture({ repo: 'o/n', provider: p,
      listPrs: () => [{ ...pr(5025, ['review:human']), headRefOid: 'a'.repeat(40), comments: [accept, record], commentsComplete: true }],
      numberingRestamp: (opts) => { seen.push(opts.pr); return { action: 'withdrawn', reason: 'withdrawn' }; } });
    expect(seen).toEqual([5025]);
    expect(result).toContainEqual({ num: 5025, numberingRestamp: 'withdrawn', detail: 'withdrawn' });
    _resetNumberingRestampMemo();
  });
  // Referral block (#5233, head c91661d6a): `gh pr list --json comments` carries no formal reviews, so a record the
  // thread alone validates can still be stranded by a review submitted between its root acceptance and the record.
  describe('a hold that exists only in formal reviews', () => {
    afterEach(() => { _resetStrandedCheckMemo(); _resetNumberingRestampMemo(); });
    const timedAccept = { ...accept, createdAt: '2026-10-12T10:00:00Z' };
    const timedRecord = { ...record, createdAt: '2026-10-12T12:00:00Z' };
    const between = [{ state: 'COMMENTED', submittedAt: '2026-10-12T11:00:00Z', user: { login: 'chalbert' }, body: 'Hold on.' }];
    const sweepWith = (labels, reviews, p = provider({ readPrState: () => ({ labels: labels.map((name) => ({ name })),
      comments: [timedAccept, timedRecord] }) })) => {
      p.readPrReviews = () => reviews;
      p.editComment = p.editComment ?? vi.fn();
      const result = sweepFixture({ repo: 'o/n', provider: p,
        listPrs: () => [{ ...pr(5025, labels), headRefOid: 'a'.repeat(40), comments: [timedAccept, timedRecord], commentsComplete: true }],
        numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: false }) });
      return { p, result };
    };
    it.each([[['review:changes']], [['review:human']], [['review:accepted']]])(
      'reads a complete listing live and withdraws the record under %j', (labels) => {
        const { p, result } = sweepWith(labels, between);
        expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'withdrawn' }));
        expect(p.editComment).toHaveBeenCalledWith('o/n', 'IC_stranded', expect.stringContaining('numbering-restamp-withdrawn:'), { pr: 5025 });
      });
    it('reads the same listed records once per head when the reviews show no hold, and again for a new record', () => {
      const p = provider({ readPrState: () => ({ labels: [{ name: 'review:changes' }], comments: [timedAccept, timedRecord] }) });
      sweepWith(['review:changes'], [], p);
      sweepWith(['review:changes'], [], p);
      expect(p.calls.readPrState).toHaveLength(1);
      expect(p.editComment).not.toHaveBeenCalled();
      const second = { ...timedRecord, id: 'IC_second', createdAt: '2026-10-12T13:00:00Z' };
      sweepFixture({ repo: 'o/n', provider: p,
        listPrs: () => [{ ...pr(5025, ['review:changes']), headRefOid: 'a'.repeat(40), comments: [timedAccept, timedRecord, second], commentsComplete: true }],
        numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: false }) });
      expect(p.calls.readPrState).toHaveLength(2);
    });
    const sweepAt = (p, at, comments = [timedAccept, timedRecord]) => sweepFixture({ repo: 'o/n', provider: p, now: () => at,
      listPrs: () => [{ ...pr(5025, ['review:changes']), headRefOid: 'a'.repeat(40), comments, commentsComplete: true }],
      numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: false }) });
    it('backs off briefly, not for good, when the formal reviews could not be read', () => {
      const p = provider({ readPrState: () => ({ labels: [{ name: 'review:changes' }], comments: [timedAccept, timedRecord] }) });
      p.readPrReviews = () => { throw Error('rate limited'); };
      p.editComment = vi.fn();
      sweepAt(p, 0);
      sweepAt(p, STRANDED_BACKOFF_MS - 1);
      expect(p.calls.readPrState).toHaveLength(1);
      p.readPrReviews = () => between;
      const result = sweepAt(p, STRANDED_BACKOFF_MS);
      expect(p.calls.readPrState).toHaveLength(2);
      expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'withdrawn' }));
    });
    it('re-checks a clean head once its check expires: an approval can strand a record nothing in the listing shows', () => {
      // A standing change request hides the review between the root and the record; the reviewer's later approval
      // lifts it, which strands the record with no new comment or record on the thread.
      const standing = { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-12T09:00:00Z', user: { login: 'other' } };
      const p = provider({ readPrState: () => ({ labels: [{ name: 'review:changes' }], comments: [timedAccept, timedRecord] }) });
      p.readPrReviews = () => [standing, ...between];
      p.editComment = vi.fn();
      sweepAt(p, 0);
      expect(p.editComment).not.toHaveBeenCalled();
      p.readPrReviews = () => [standing, ...between, { state: 'APPROVED', submittedAt: '2026-10-12T14:00:00Z', user: { login: 'other' } }];
      sweepAt(p, STRANDED_RECHECK_MS - 1);
      expect(p.editComment).not.toHaveBeenCalled();
      const result = sweepAt(p, STRANDED_RECHECK_MS);
      expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'withdrawn' }));
      expect(p.editComment).toHaveBeenCalledWith('o/n', 'IC_stranded', expect.stringContaining('numbering-restamp-withdrawn:'), { pr: 5025 });
    });
    it('backs off briefly when the live read itself fails', () => {
      const p = provider({ readPrState: () => { throw Error('rate limited'); } });
      sweepAt(p, 0);
      sweepAt(p, 1);
      expect(p.calls.readPrState).toHaveLength(1);
      sweepAt(p, STRANDED_BACKOFF_MS);
      expect(p.calls.readPrState).toHaveLength(2);
    });
  });
  // Self-review (#5233): `gh pr list --json comments` stops at the first page, so a record past it is invisible there.
  describe('a capped listing on a label-held PR', () => {
    afterEach(_resetStrandedCheckMemo);
    const filler = Array.from({ length: 100 }, (_, i) => ({ author: { login: 'stranger' }, body: `discussion ${i}` }));
    const capped = (extra = {}) => ({ ...pr(5025, ['review:changes']), headRefOid: 'a'.repeat(40), comments: filler, ...extra });
    it('reads the full thread live and withdraws a stranded record past the first page', () => {
      const p = provider({ readPrState: () => ({ labels: [{ name: 'review:changes' }], comments: [accept, ...filler, objection, record] }) });
      p.readPrReviews = () => [];
      p.editComment = vi.fn();
      const result = sweepFixture({ repo: 'o/n', provider: p, listPrs: () => [capped()],
        numberingRestamp: (opts) => restampAfterNumbering({ ...opts, enabled: false }) });
      expect(result).toContainEqual(expect.objectContaining({ num: 5025, numberingRestamp: 'withdrawn' }));
      expect(p.editComment).toHaveBeenCalledWith('o/n', 'IC_stranded', expect.stringContaining('numbering-restamp-withdrawn:'), { pr: 5025 });
    });
    it('reads a capped head once, then not again until a pass on it writes or fails', () => {
      const p = provider();
      p.readPrReviews = () => [];
      const seen = [];
      const sweep = (r) => sweepFixture({ repo: 'o/n', provider: p, listPrs: () => [capped()],
        numberingRestamp: (opts) => { seen.push(opts.pr); return r; } });
      sweep(null);
      sweep(null);
      expect(seen).toEqual([5025]);
      _resetStrandedCheckMemo();
      sweep({ action: 'error', reason: 'withdrawal failed: offline' });
      sweep(null);
      expect(seen).toEqual([5025, 5025, 5025]);
    });
    it('reads a checked capped head again once its check expires (a record may land past the first page)', () => {
      const p = provider();
      p.readPrReviews = () => [];
      const seen = [];
      const sweep = (at) => sweepFixture({ repo: 'o/n', provider: p, listPrs: () => [capped()], now: () => at,
        numberingRestamp: (opts) => { seen.push(opts.pr); return null; } });
      sweep(0);
      sweep(STRANDED_RECHECK_MS - 1);
      expect(seen).toEqual([5025]);
      sweep(STRANDED_RECHECK_MS);
      expect(seen).toEqual([5025, 5025]);
    });
    it('trusts a listing the complete reader marked complete', () => {
      const seen = [];
      sweepFixture({ repo: 'o/n', provider: provider(), listPrs: () => [capped({ commentsComplete: true })],
        numberingRestamp: (opts) => { seen.push(opts.pr); return null; } });
      expect(seen).toEqual([]);
    });
  });
});
