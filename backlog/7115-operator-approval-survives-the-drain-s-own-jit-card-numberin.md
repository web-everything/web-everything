---
bornAs: xxj37pd
kind: story
size: 5
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/lib/red-team-carry-io.mjs", "we:scripts/lib/red-team-gate.mjs", "we:scripts/lib/queue-branch-numbering.mjs", "we:scripts/__tests__/review-set-label.test.mjs", "we:scripts/__tests__/review-referral-evidence-carry.test.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/lib/__tests__/red-team-carry-machine.test.mjs", "we:scripts/lib/__tests__/queue-branch-numbering.test.mjs"]
dateOpened: "2026-10-25"
preparedDate: "2026-10-31"
preparedAgainstSha: "abbd8c6c1c437208810b23b3be1c915a8368b55b"
tags: []
---

# Operator approval survives the drain's own JIT card-numbering push

#5608 (clear at 01:00Z, renumber push at 01:04Z, 2026-10-23 23:05 ET) and #5878 (2026-10-25 08:23 ET): the drain dequeues a human-enqueued PR to JIT-number its hash cards and says 're-enqueued after CI', but human-only PRs cannot be re-enqueued by the drain, and the clearance carry refuses when 'a later verdict or unknown comment stands'. Want: number cards BEFORE asking for the human enqueue, or carry the clearance/human enqueue across the numbering-only commit (verified by patch comparison), and make the carry ignore advisory or bot verdict comments that do not change review state. Also append one JSONL event (PR, old sha, new sha, cause: renumber/empty/rebase/main-merge) whenever an approval is lost to a new head so the coroner can count it (coroner 2026-10-20, card 372). Existing human-enqueue card 6249 covers the tool, not this loop.

**Third live case — PR #6059 (2026-10-31).** The operator approved head `41864451` and recorded a red-team override (record-red-team-ruling run `13c6f391`, card 7533) at 08:51 ET. The drain's merge-queue step then committed "numbered card(s) on branch before enqueue → 56921e133" (4 `backlog/756x` renames, 1 line each). Its acceptance re-stamp failed: `mandatory referral hold: no-current-head-review-evidence; no readable referral record or completed clean review for current head 56921e133…` (drain `daemon.log` line ~564967). The red team then re-ran on `56921e13`, re-raised the same break (result `cfcd498e`), and set `red-team:blocked` again. The orchestrator had to re-record the operator ruling by hand (run `70239144`) at 10:07 ET. An independent review on `56921e13` that abstained did not count as evidence either.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/__tests__/review-referral-evidence-carry.test.mjs we:scripts/lib/__tests__/red-team-carry-machine.test.mjs we:scripts/lib/__tests__/queue-branch-numbering.test.mjs` fails before this lands (the new #6059-shaped cases: referral carry across a numbering-only move, red-team operator-ruling carry, approval-lost event) and passes after.
- [A2] **Must — refuse on error.** Any proof read miss, a move that is not proven numbering-only, a successor head carrying its own hold, or an unreadable predecessor record refuses the carry with a named reason. The refusal keeps today's hold exactly.
- [A3] **Must — no new trust.** The carry only moves evidence that already exists on the predecessor head. It never creates an approval, a referral ruling or a red-team ruling the operator did not give on that head.

## Non-goals

- [N1] Numbering cards earlier (at PR open or before review). Considered and rejected for this card, see *Design — why not renumber first*.
- [N2] Carrying across any other head move (rebase onto main, CI heal, main merge). Those keep their existing carries (#4708 byte-identical net diff, accept-carry-forward). The conflicting-main-merge loss is decided in *Design — Case 2* and built as a follow-up.
- [N3] The human-enqueue tool itself (card 6249).

## Design

**The one proof.** "Is successor `B` a card-renumber-only move of head `A`?" is already answered by `proveNumberingOnlyMove({ exec, fromSha, toSha })` in `we:scripts/lib/numbering-carry.mjs:216`. It requires a bounded linear chain of trusted `drain: JIT-number … at land (#2288)` commits (`NUMBERING_SUBJECT_RE`, `:40`; author allowlist from `trustedDrainAuthors`, `we:scripts/lib/queue-branch-numbering.mjs:23`). Each change must be a hash→number card rename or a mapped reference rewrite (`checkNumberingCommit`, `:108`), within the file/byte caps (`:41-44`). It fails closed. The branch-numbering step (`prepareBranchBeforeEnqueue`, `we:scripts/lib/queue-branch-numbering.mjs:~250`) commits through `numberPendingHashes`, so its commit carries that subject. No new proof is written. Every carry below calls this one function. `proveCardOnlyHeadMove` (`we:scripts/lib/card-only-head-move.mjs:14`) is NOT used: its card-only fallback accepts any card edit, which is wider than a renumber.

**Gap 1 — mandatory referral gate.** `assertMandatoryReferralsCleared` (`we:scripts/review-set-label.mjs:2765`) refuses a head with no own record unless `referralEvidenceCarry` (`:2741`) succeeds. That carry fails on #6059 for three reasons:
1. It needs the strict net diffs byte-identical (`:2753`). A renumber renames cards and edits lines, so they never match.
2. It needs the predecessor's latest run *clean* (`:2747`). On #6059 the run was parked and the operator then ruled it. A ruled-after-park run is not "clean".
3. `mine.some(r => r.head === head)` (`:2745`) aborts the carry when ANY run exists on the successor, including an abstained one.

Change: add a second carry branch, `numberingReferralCarry`. When `proveNumberingOnlyMove(prior.head → head)` is ok:
- (a) accept the move in place of the fingerprint check;
- (b) drop the "prior run clean" precondition. The carry already re-evaluates the predecessor head live (`:2806`, `assertMandatoryReferralsCleared({ ...state, headRefOid: carried.fromHead }, { carry: false })`). That re-check reads the operator's referral rulings on that head and refuses any hold still standing;
- (c) a successor run counts as blocking only if it is parked, failed, has pending referrals or failed persistence. An abstained/no-verdict run is ignored (it is not evidence either way).

The durable verdict record gains `kind: "numbering"` plus the proof reason in `renderReferralCarryRecord` (`:2757`), so readers can tell it apart from a byte-identical carry. The existing restamp path (`--to=restamp --new-head`, `we:scripts/merge-ai-prs.mjs:1298`, called from `finishBranchPreparation`, `we:scripts/lib/queue-branch-numbering.mjs:316-320`) then passes without new wiring.

**Gap 2 — red-team gate.** Operator rulings bind to `(pr, head, resultId)`: see `operatorRulingsOnLiveResult` (`we:scripts/lib/red-team-gate.mjs:722`) and the `record-red-team-ruling` ids (`we:scripts/operations/record-red-team-ruling.mjs:53-64`). A new head therefore has no result and no ruling, so the red team re-runs and re-blocks. The existing `createRedTeamCarryIo().eligible` (`we:scripts/lib/red-team-carry-io.mjs:28`) only settles the *card-only-PR skip* policy (`cardOnlyHeadMoveCandidate`, `we:scripts/lib/review-red-team-on-skip.mjs:81`). It also refuses `red-team:blocked` outright. Change: add a numbering carry for the red-team result. When the successor has no red-team result of its own and `proveNumberingOnlyMove(A → B)` is ok, post one trusted carry marker on `B` naming `{from: A, to: B, resultId, rulings: [gate record ids]}`. The red-team readers (`liveResultGateState`, `readRedTeamDisposition`, `operatorRulingsOnLiveResult`) resolve `B` through that marker to `A`'s latest result and to the operator gate records bound to it. The dispatcher sees a settled result on `B` and does not re-run. The label is then recomputed from `A`'s disposition: `red-team:clear` if `A` was cleared or operator-overridden, `red-team:blocked` if `A` was blocked. Carrying a block is a feature, not a risk.

**Gap 3 — count lost approvals.** `finishBranchPreparation` (`we:scripts/lib/queue-branch-numbering.mjs:312`) emits one `appendDaemonEvent({ kind: 'approval-lost', pr, from, to, cause: 'renumber', reason })` when the re-stamp still fails. The coroner can then count every remaining loss.

**Why not renumber first** (the other option the brief named). Numbering is just-in-time at enqueue on purpose. Numbers are allocated under the drain numbering mutex against the live `main` floor (`reservationPlan`, `:276-279`). Numbering at PR open or before review would still collide with parallel lanes, and the collision-heal (#2071/#2181) would then move the head anyway. So the carry is needed either way. Renumber-first stays a follow-up that would only reduce how often the carry fires.

**Case 2 — approval lost to a conflicting main merge while waiting (decided here, built as a follow-up).** Live: #6059 was approved at 08:51 ET. At 10:17 ET it was `review:changes` with merge status conflicting: main moved during the wait, the PR got a merge commit, and the approval did not carry. Most of that wait came from Case 1: the failed re-stamp kept it out of the queue until the 10:07 re-ruling. Fixing Case 1 shrinks the window but does not close it. The three options weighed:
- (a) **Enqueue approved human-required PRs at once, ahead of the catch-up order.** This is the pick. A PR in the GitHub merge queue is tested against the moving main by the queue itself. The drain never writes a merge commit on the branch, so the approved head never moves. A real conflict ejects it, and it comes back for a fresh look. The hook already exists: `planCatchUp` order `priority-then-first-accept` (`we:scripts/lib/enqueue-on-event.mjs:508`). It needs an "operator-approved human-required" top tier, and an approval event must wake it instead of waiting for the 10-minute catch-up tick.
- (b) Carry the approval across a conflict-free main merge when the PR's own patch is unchanged (range-diff / patch-id). Rejected as the fix. The conflict-free case is already covered by the #4708 byte-identical net-diff carry (`referralEvidenceCarry`, `we:scripts/review-set-label.mjs:2741`). And #6059's case was a *conflict*: the resolution is new code the operator never saw, so no carry is safe there.
- (c) Bind approval to the net patch instead of the head SHA. Rejected. It changes the identity model of every gate (review, referral, red team, ruling ids keyed by head), which is far wider than this bug. It still could not carry across a conflict resolution.

## MVP

Musts only:
1. `numberingReferralCarry` in `we:scripts/review-set-label.mjs`, as Design Gap 1 (a)–(c), with the `kind: "numbering"` carry record.
2. The red-team numbering carry marker and reader resolution (Design Gap 2), in `we:scripts/lib/red-team-carry-io.mjs` + `we:scripts/lib/red-team-gate.mjs`. It covers operator-override, operator-card and operator-block rulings plus automated clear outcomes.
3. The `approval-lost` event (Design Gap 3).
4. Every carry calls `proveNumberingOnlyMove` and nothing wider. Out: the human-enqueue re-enqueue (card 6249), ignoring advisory bot verdict comments (the existing `isNumberingTolerableLaterBody`, `we:scripts/lib/numbering-carry.mjs:407`, already covers the review clearance carry), renumber-first.

## Test plan

All cases in vitest with injected `exec`/run stores (no network). Each is RED on current `main`:
- **referral carry, #6059 shape** (`we:scripts/__tests__/review-referral-evidence-carry.test.mjs`): predecessor run parked and then operator-ruled, successor reached by a JIT-number rename commit → the restamp passes and the record shows `kind: numbering`. RED today: `no-current-head-review-evidence`.
- **referral carry, abstained successor run**: same, plus an abstained run on `B` → still carries. RED today: `mine.some(head)` aborts.
- **referral refusal, non-card change**: the same commit also touches `we:scripts/x.mjs` → refuses with the proof reason. Guards A2. Green today, must stay green.
- **referral refusal, untrusted author / wrong subject / a card body edit beyond the number line** → refuses.
- **referral refusal, the predecessor still holds** (an unruled pending referral on `A`) → refuses with the hold name. This stays true after the change: the carry never weakens the gate.
- **referral refusal, a successor-only hold** (a record-shaped comment on `B` holding) → refuses (the `:2799` path).
- **red-team carry, operator override** (`we:scripts/lib/__tests__/red-team-carry-machine.test.mjs`): `A` has result + operator-override record, `B` is a numbering move → marker posted, `B` reads cleared, no dispatch. RED today: re-dispatch.
- **red-team carry, a block carries**: `A` operator-block → `B` reads blocked.
- **red-team refusal, proof fails or `B` already has its own result** → no marker, the normal run goes ahead.
- **red-team marker forged by a non-trusted author** → ignored.
- **approval-lost event** (`we:scripts/lib/__tests__/queue-branch-numbering.test.mjs`): restamp fails → exactly one event with `from`/`to`/`cause: renumber`. Restamp ok → no event.

## Proof plan

Live before/after, not only tests:
- **Before:** the #6059 log line (`daemon.log` ~564967) plus the `cfcd498e` re-block on `56921e13`.
- **After:** dry-run the restamp against #6059's real heads: a read-only probe (`node -e` importing `assertMandatoryReferralsCleared` from we:scripts/review-set-label.mjs, which has no `--dry-run` flag) on #6059's live PR state with `headRefOid` set to `56921e133e6cfc4c2b422e6b81bd1ba7a7e8b454`, in a clone that has both SHAs fetched. Expect a carry with `kind: numbering` from `41864451` (the operator rulings on `41864451` are already on the thread). Then a dry-run red-team carry read on the same pair: it shows the override resolved for `56921e13`. Finally, the next real PR whose drain numbering lands after an approval shows "numbered … → <sha>" with NO "acceptance re-stamp failed", no red-team re-run, and no `approval-lost` event.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — commit subjects, card names and comment bodies reach regexes only through the existing anchored `NUMBERING_SUBJECT_RE`/marker parsers. The carry marker body is built from SHAs and ids only. Any free text written into a note goes through `foldUntrusted`.
2. **Truncated reads** — `proveNumberingOnlyMove` already caps commits/files/bytes and refuses past the caps. PR comments come from `readCompletePrComments`. A short page is a refusal, never "no hold".
3. **Shared state files** — the review run store and the red-team status store are written only through their existing atomic writers. The red-team marker post is re-read before and after writing (the same compare-and-set as `replanBeforeWrite`, `we:scripts/lib/numbering-carry.mjs:530`).
4. **Fail closed** — any proof `{ok:false}`, a `retryable` read miss, or an unreadable predecessor record → the original hold stands, with the reason named. A retryable miss is never memoized as settled.
5. **Identity scoping** — every carry key is `repo + pr + fromSha + toSha`. Rulings are taken only from the same PR's predecessor head and that head's latest result id.
6. **State over time** — a chain `A→B→C` (two numbering pushes) carries `A` to `C` through the bounded chain. A real head move after `B` drops the carry: the marker names `to: B`, so it cannot apply to `C`. A ruling posted on `A` after the carry is re-read live, not frozen.
7. **Who wrote it** — the JIT-number commits must come from `trustedDrainAuthors` (read from `origin/main`, never from the PR). The red-team carry marker counts only from `isTrustedMarkerAuthor`. Operator rulings keep their `isHumanOperatorComment` check on `A`.

## Proposed blockedBy changes

- none. Sibling card 7308 (red-team carry recovery rejected after a numbering re-stamp, `we:scripts/lib/red-team-carry-io.mjs:33`) overlaps Gap 2. The reviewer may fold it into this card or mark it a duplicate once this lands.

## Follow-ups

- Renumber-first: number hash cards at PR open, so most approvals land on an already-numbered head (cuts carry frequency, not needed for correctness).
- Re-enqueue a human-enqueued PR after the drain's own numbering push (the #5608/#5878 half; tool side is card 6249).
- **Approved human-required PRs enqueue at once (Case 2, option a).** Scope: `we:scripts/lib/enqueue-on-event.mjs` (`planCatchUp` top tier + wake on the approval event) and its test. Acceptance: an approved human-required PR is enqueued in the same pass as its approval, before any other ready PR. A main move after that never writes a merge commit on its branch. Proof: the next approved human-required PR goes from approval to queued in under one catch-up interval.
- Extend the `approval-lost` event to the rebase / main-merge / CI-heal paths (`we:scripts/merge-ai-prs.mjs:5649`, `:6586`; `we:scripts/lib/merge-queue-enqueue.mjs:138`).

## Progress

- 2026-10-31 prepare: premise holds on `abbd8c6c1c` (no delivering commit for 7115/`xxj37pd`). Scope corrected from `[we:scripts/merge-ai-prs.mjs, we:scripts/review-set-label.mjs]` to the referral carry, red-team carry/gate and branch-numbering files plus their tests. `we:scripts/merge-ai-prs.mjs` needs no change: its `restampAcceptance` already passes `--new-head`. Size 3→5: two gates (referral `we:scripts/review-set-label.mjs:2741-2812`, red-team `we:scripts/lib/red-team-gate.mjs:722` + `we:scripts/lib/red-team-carry-io.mjs:28`) plus one event. Added the #6059 live case.
