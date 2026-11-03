import { describe, it, expect } from 'vitest';
import { classifyReason } from '../cause-codes.mjs';
// Verbatim daemon lines; these are data, never commands.
export const realReasons = [
  [
    "2026-11-02T04:58:06.307Z reconcile-fix-dispatch-daemon: refused dispatch-failed web-everything/web-everything PR #6193 \u2014 dispatch-lane: the value for {{SCOPE}} (\"we:scripts/readiness/heavy-admission.mjs we:scripts/readiness/remote-exec.mjs\") has characters the brief cannot carry safely \u2014 it is pasted UNQUOTED into a shell command the agent is told to run. Refusing.",
    "dispatch:scope-unsafe"
  ],
  [
    "2026-10-31T03:55:27.345Z reconcile-fix-dispatch-daemon: refused host-load web-everything/web-everything PR #6033 \u2014 decided by admit({kind:'ci-heal'}): wait \u2014 cpu idle 4.2% < 8% (snapshot age 5s; legacy said admit); ci-heal launch deferred, running work untouched",
    "dispatch:host-load"
  ],
  [
    "2026-10-31T04:25:09.413Z reconcile-fix-dispatch-daemon: refused draft-not-promoted web-everything/web-everything PR #6118 \u2014 draft left as is: its required checks read pending, not green, in this tick's plan \u2014 nothing to promote yet",
    "dispatch:draft-not-promoted"
  ],
  [
    "2026-10-31T03:02:44.154Z reconcile-fix-dispatch-daemon: refused fix-loop-hold web-everything/web-everything PR #6033 \u2014 3 ci-heal/fix sessions (3 raw, 0 infrastructure discount) on head 4caffe4; re-arms on the stronger-model rung at 2026-10-31T03:40:39.281Z or when the fixer build changes; rearmAfterMinutes=120 (source default)",
    "fix:loop-hold"
  ],
  [
    "2026-10-31T03:02:44.154Z reconcile-fix-dispatch-daemon: refused own-failure web-everything/web-everything PR #6033 \u2014 PR #6033's required check failed at 2026-10-31T00:56:16Z, outside every red-`main` window \u2014 this is the PR's own failure, owed a ci-heal, not a rebase",
    "fix:ci-heal-wait"
  ],
  [
    "2026-10-31T03:02:44.154Z reconcile-fix-dispatch-daemon: reconcile-refused review-referrals-pending web-everything/web-everything PR #6105 \u2014 review paused: head dd0eaf607 was already reviewed 1 time(s); it resumes on a new push or an explicit re-arm",
    "review:pickup-wait:review-referrals-pending"
  ],
  [
    "2026-10-31T03:02:44.154Z reconcile-fix-dispatch-daemon: reconcile-refused review-ci web-everything/web-everything PR #6100 \u2014 required-checks-not-successful: test-shard (1)=pending",
    "review:pickup-wait:review-ci"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused nothing-owed web-everything/web-everything PR #6085 \u2014 phase `queued` \u2014 reviewed and queued, or already landed; this pass has nothing to dispatch",
    "dispatch:nothing-owed"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused already-reviewed-head web-everything/web-everything PR #6084 \u2014 referral hold auto-resolved \u2014 every referral finding on head 71569b3a9 is ruled (2 not-real); no ruling is owed; this head's review already ran with those rulings and its advisory is current, so the next step is the human /review (`review:human` kept); no new panel on an unchanged head",
    "review:pickup-wait:already-reviewed-head"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused owed-elsewhere web-everything/web-everything PR #6041 \u2014 the branch needs a rebase before it can merge",
    "dispatch:owed-elsewhere"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused timeout-retry-ineligible web-everything/web-everything PR #6033 \u2014 PR #6033: mixed-infra-cancelled-and-real-failure",
    "review:juror-timeout"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused cap-exhausted web-everything/web-everything PR #6023 \u2014 the PR's own durable attempt count is 10 against a cap of 7 \u2014 auto-repair is exhausted here and a person must take it",
    "fix:cap-exhausted"
  ],
  [
    "2026-10-31T03:02:44.155Z reconcile-fix-dispatch-daemon: reconcile-refused fix-claimed web-everything/web-everything PR #6046 \u2014 fix-6046 holds the fix claim (conveyor fix: address review on PR #6046) \u2014 nothing is dispatched until its fix-end",
    "fix:claimed"
  ],
  [
    "2026-10-31T13:32:47.217Z reconcile-fix-dispatch-daemon: note ruling-dispute web-everything/web-everything PR #6023 \u2014 PR #6023: 1 confirmed finding(s) the operator ruled \"block\" came back on the new head (3 misses after the ruling) \u2014 fixer and reviewer disagree; a person (or an arbiter) must decide. Ladder so far: resend > stronger-model. scripts/lib/daemon-clone-entries.mjs:54",
    "redteam:ruling-dispute"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6105 review:pending+review:human, no review dispatched \u2014 owed a promote-draft, not a review \u2014 draft PR \u2014 required checks are green or held only for review; promote it to ready for review (draft-first PRs, operator-approved 2026-09-27) \u2014 nothing else is owed this PR until that happens",
    "review:pickup-wait:owed"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6101 ci:failed, no review dispatched \u2014 owed a ci-heal, not a review \u2014 a required check is failing (test), nothing live is working it, and 0 of 3 CI-heal attempts are spent (cap from standard); timeout-retry-ineligible: PR #6101: timeout-evidence:stale-head",
    "review:juror-timeout"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6104 ci:failed, no review dispatched \u2014 owed a ci-heal, not a review \u2014 a required check is failing (test), nothing live is working it, and 0 of 3 CI-heal attempts are spent (cap from standard)",
    "review:pickup-wait:owed"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6103 review:pending, no review dispatched \u2014 review owed, but no acquirable lane this tick (8 acquirable)",
    "review:pickup-wait:no-lane"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6059 review:pending, no review dispatched \u2014 review-ci: required-checks-not-successful: test-shard (1)=pending",
    "review:pickup-wait:review-ci"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6056 review:human, no review dispatched \u2014 already-reviewed-head: referral hold auto-resolved \u2014 every referral finding on head bfdb5352e is ruled (4 not-real); no ruling is owed; this head's review already ran with those rulings and its advisory is current, so the next step is the human /review (`review:human` kept); no new panel on an unchanged head",
    "review:pickup-wait:already-reviewed-head"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6046 review:pending, no review dispatched \u2014 stood-down: a fix agent already stopped here to ask a question \u2014 re-dispatching would re-ask it forever. Terminal on this head until an explicit operator answer is recorded with stand-down-answer.mjs. fix.standDownHoldsAcrossHeads=false (source: standard).",
    "review:pickup-wait:stood-down"
  ],
  [
    "2026-10-30T14:06:57.950Z review-daemon: web-everything/web-everything#6023 review:human, no review dispatched \u2014 cap-exhausted: the PR's own durable attempt count is 8 against a cap of 7 \u2014 auto-repair is exhausted here and a person must take it",
    "fix:cap-exhausted"
  ],
  [
    "2026-10-30T14:26:37.842Z review-daemon: web-everything/web-everything#6103 review:pending, no review dispatched \u2014 review owed, but held by the live-review cap (live review rounds 5 of maxLiveReviewRounds=12 (env); 11 lane(s) acquirable)",
    "review:pickup-wait:live-review-cap"
  ],
  [
    "2026-10-30T14:26:37.842Z review-daemon: web-everything/web-everything#6059 review:pending, no review dispatched \u2014 review-referrals-pending: review paused: head 3da43988b was already reviewed 1 time(s); it resumes on a new push or an explicit re-arm",
    "review:pickup-wait:review-referrals-pending"
  ],
  [
    "[drain-daemon] 2026-10-20T13:26:56.555Z enqueue-on-event: catch-up #5729 fast drain exit 0 in 572s \u2014 skipped: red-main-hold: shared freeze unreadable: branch unreadable: spawnSync git ETIMEDOUT; red-main-hold: main is red [manual] \u2014 nothing lands (no main-fix PR published yet) until main is green [outcome=skipped] \u00b7 phases: listing=62605ms classifyGateReads=12355ms mergeCascade=11ms postMergeSync=35178ms duplicateCheck=430ms listing.snapshot=12994ms listing.defaultBranch=1817ms listing.target=2890ms listing.pages=13451ms listing.checks=4239ms listing.context=29017ms total=413390ms",
    "drain:blocked-all:freeze-unreadable"
  ],
  [
    "[drain-daemon] 2026-10-09T14:32:43.465Z   web-everything/web-everything#4626 skipped: red-main-hold: main is red [manual] \u2014 nothing lands (no main-fix PR published yet) until main is green",
    "drain:blocked-all:main-red"
  ]
];
describe('real daemon reason codes', () => {
 it.each(realReasons)('%s', (raw, key) => {
  expect(classifyReason(raw).key).toBe(key);
  expect(key).not.toMatch(/(?:^|:)\d+(?:$|:)|[a-f0-9]{7,40}/);
 });
 it('preserves unmapped evidence and removes volatile identity from keys', () => {
  const raw = '2026-11-02T04:58:06.307Z PR #6193 abc123def456 a novel refusal';
  expect(classifyReason(raw)).toMatchObject({stage: 'unknown', raw});
  expect(classifyReason(raw).key).toBe('other:a-novel-refusal');
 });
});
