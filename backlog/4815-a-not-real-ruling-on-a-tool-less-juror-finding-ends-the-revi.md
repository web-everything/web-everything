---
bornAs: xfkqowg
kind: story
size: 3
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-02"
preparedDate: "2026-10-09"
preparedAgainstSha: "5115db8edfb5d5994f6246e155d3bf1f4e0c224f"
tags: []
---

# A not-real ruling on a tool-less juror finding ends the review run, so a review:human PR gets its advisory instead of looping

Make unsupported tool-less confirmation non-authoritative, preserve a valid finding-specific `not-real` closure for the reviewed head, and stop automatic duplicate review after the advisory completes. Replay the reported PR #3432 shape: one run, one advisory, no repeat dispatch for unchanged completed work.

## Progress

Re-prepared 2026-10-09 against `main` @ 5115db8ed. The first prepare (2026-10-02) predates the operator's confirmation-turn ruling (below) and cites code that has since moved; it is replaced, not patched.

Old premise: the core lacked cross-run `not-real` carry, an operator ruling path, and a tool-less downgrade. Corrected premise, by source evidence on current `main`:
- Cross-run carry of a same-head/same-finding ruling is **delivered**: `findCarriedReviewerRuling` / `findCarriedOperatorRuling` (`we:scripts/lib/jury-core.mjs:2996`, `we:scripts/lib/jury-core.mjs:2896`), PR #3967 / #4441.
- The operator ruling path that unblocks `--to=clear-human` is **delivered**: `we:scripts/operations/record-referral-ruling.mjs` (#4979), read by `assertMandatoryReferralsCleared` (`we:scripts/review-set-label.mjs:2010`).
- **Not delivered (the remaining Must):** a tool-less seat's `CONFIRMED` broken/unrecoverable finding still becomes a mandatory referral on its own say-so. `requiresMandatoryReferral` checks only verdict + impact (`we:scripts/lib/jury-core.mjs:2788`) and the reduce step feeds every seat's findings to it (`we:scripts/operations/review-pr.mjs:2571`). Tool-free seats: `judgeAdvisory`, `judgeAntigravityReview` (`we:scripts/operations/review-pr.mjs:553`, `we:scripts/operations/review-pr.mjs:2391`) and the tool-free Claude panel jurors (`we:scripts/operations/review-pr.mjs:1310`).
- Scope narrowed: `we:scripts/conveyor/reconcile-core.mjs` and its test are dropped. Duplicate dispatch stops once the referral stops being raised falsely; no evidence from current code that reconciliation itself loops.

The incident counts (51 records on #3432) are reported context; the root-cause section below is the orchestrator's decode and is not re-verified here.

## Design

Implement the operator's ruling: a **confirmation turn** at referral admission, `we:scripts/operations/review-pr.mjs:2571`.
1. Seat capability is an explicit new field, `tools: true|false`, added to each seat constant (`ADVISORY_JUDGE_SEAT` `we:scripts/operations/review-pr.mjs:350`, `CORRECTNESS_ADVISORY_SEAT` `we:scripts/operations/review-pr.mjs:459`, `ANTIGRAVITY_REVIEW_SEAT` `we:scripts/operations/review-pr.mjs:534`, `AGY_CORRECTNESS_SEAT` `we:scripts/operations/review-pr.mjs:546`) and to the panel jurors' seat records; today capability exists only in comments (`we:scripts/operations/review-pr.mjs:1310`, `we:scripts/operations/review-pr.mjs:1327`), and `allowedTools` omission is not a signal (the correctness-advisory seat omits it yet has a read-only shell, `we:scripts/operations/review-pr.mjs:2368`). The build MUST first confirm each seat's real capability from its request recipe (the Antigravity seat is documented tool-free, `we:scripts/lib/antigravity-judge-spawn.mjs:107`) and record it in the field. Add one pure helper beside `requiresMandatoryReferral` (`we:scripts/lib/jury-core.mjs:2788`) that, given the seat's `tools` field, says whether a `CONFIRMED` broken/unrecoverable finding needs verification. A seat with no `tools` field is treated as needing verification (fail closed on the claim, not on the PR); a test asserts every seat in `ADVISORY_SEAT_STEPS` declares the field.
2. For a tool-less seat's qualifying finding, before it is pushed to `referrals`, run ONE tool-bearing verifier turn. The verifier is a NEW operation step declared beside the other judge steps (`we:scripts/operations/review-pr.mjs:2368`-`we:scripts/operations/review-pr.mjs:2420`), built from the correctness-advisory seat's tool-bearing request recipe, with its own request builder asking only: reproduce this claim on the PR head. (`mandatoryReferralReviewer`, `we:scripts/lib/jury-core.mjs:2810`, is only an id derivation for the referral record and is not the verifier.) Reproduced: finding stays `CONFIRMED` and is referred exactly as today. Not reproduced, or the verifier errors/times out/returns malformed output: it is downgraded to an advisory note (original assertion + "unverified by a tool-bearing seat" kept visible) and never blocks the run. A verifier failure must not clear an already-recorded durable referral for the same key.
3. Cost only on the claim: no verifier turn when no tool-less seat raises a qualifying finding, and at most one per finding key per head (reuse `referralFindingKey`, `we:scripts/lib/jury-core.mjs:2794`; a result is persisted with the existing referral snapshot so a re-run on the same head does not re-verify).
4. No renderer change: `renderReferralRecord` already prints "finding-specific rulings recorded" for a fully ruled record and the pending text only when findings are pending (`we:scripts/lib/jury-core.mjs:3230`); the 2026-10-02 card text claiming otherwise was wrong.
5. Operator deadlock path is delivered (`we:scripts/operations/record-referral-ruling.mjs`, covered by `we:scripts/operations/__tests__/record-referral-ruling.test.mjs:206`, which asserts the gate clears after an operator ruling); this card adds no work there.

## MVP

Musts only: (a) the explicit seat `tools` field + capability helper; (b) the single verifier step with downgrade-on-not-reproduced; (c) persistence of the verifier outcome on the head's snapshot in `we:scripts/operations/review-pr-io.mjs`. OUT (Follow-ups): giving every reviewer read-only tools; historical #3432 replay; new retry budget or authority policy; reconcile-core changes; finding-identity redesign.

## Edge cases this change must handle

1. Untrusted text — juror finding text reaches the verifier prompt and the advisory note: fold with `foldUntrusted` (`we:scripts/lib/jury-core.mjs`); the verifier prompt passes the finding as data, never as argv. Test: finding summary containing newlines, backticks and a leading `--`.
2. Truncated reads — the verifier's PR-head diff/context is built by the same builder the other tool-bearing seats use (`buildReviewCorrectnessAdvisoryJudgeRequest`); a read hitting a limit is a verifier failure (finding held as unverified-advisory), never "not reproduced" success. Test: injected truncated diff.
3. Shared state files — the outcome is written in the existing atomic snapshot path (`we:scripts/operations/review-pr-io.mjs`); n/a beyond that: no new file, no new writer.
4. Fail closed — verifier spawn/parse failure: the claim is NOT promoted to a blocker and NOT silently dropped; it is shown as an unverified advisory with the reason. A pre-existing durable referral is untouched.
5. Identity scoping — verifier outcome keyed by repo + PR + head sha + finding key; a new head re-verifies. Test: same finding on two heads.
6. State over time — restart mid-verification: spent attempt is not respawned (existing attempted-snapshot behaviour); changed head invalidates the outcome.
7. Who wrote it — capability is read from the seat declaration, not from a juror's own claim about its tools; a tool-bearing seat's finding bypasses the turn. Test: correctness-advisory seat (no `allowedTools`, has shell) is NOT treated as tool-less.

## Test plan

- `we:scripts/lib/__tests__/jury-core.test.mjs` — capability helper: tool-less CONFIRMED broken → needs verification (RED today: no helper, every such finding is referred); tool-bearing → no; unknown capability → needs verification.
- `we:scripts/operations/__tests__/review-pr.test.mjs` — reduce: tool-less CONFIRMED + verifier "not reproduced" → no referral, finding appears as advisory with original text (RED today: referral created); "reproduced" → referral as today; verifier failure → advisory, run not blocked; tool-bearing seat → no verifier turn; mixed findings: unrelated blocker still governs; non-code finding kinds (docs/config/data) behave the same.
- `we:scripts/operations/__tests__/review-pr-io.test.mjs` — outcome persisted on the head snapshot; second run on same head does not respawn the verifier; new head re-verifies; pre-existing referral survives a failed verifier.
- Seat-declaration case: every seat in `ADVISORY_SEAT_STEPS` declares `tools` (RED today: field absent).
- Only the helper, not-reproduced, seat-declaration, and same-head/new-head verifier-outcome cases are claimed red→green. Controls (already green, NOT claimed red→green): reproduced → referral as today, tool-bearing seat → no verifier turn, failed verifier keeps a pre-existing referral, non-code kinds, carried `not-real` ruling, operator `record-referral-ruling` path.

## Proof plan

Harness: the existing `runReviewPr`-style operation tests with injected judge answers in `we:scripts/operations/__tests__/review-pr.test.mjs` and the injected sink in `we:scripts/operations/__tests__/review-pr-io.test.mjs`. Run the three scoped suites with `npx vitest run <the three files>`; the new cases above fail on pre-change `main` and pass after (record names + output in Progress). Then, through the operation engine with the injected sink harness, replay a synthetic #3432-shaped run (tool-less Antigravity CONFIRMED finding, verifier not-reproduced) and capture: referral records written (expect none), advisory note count (expect exactly one), verdict, and a second run on the same head (expect no new verifier turn, no new referral). Label it synthetic; the historical #3432 artifacts are a Follow-up. Never post to a live PR as part of proof. Then the lane verifier and standards gate.

## Done when

The three scoped suites pass with the new red→green cases: a tool-less juror's unreproduced CONFIRMED claim is downgraded to an advisory note and never blocks; a reproduced one still needs a ruling; the human advisory publishes once; edge-case controls pass; lane verifier and standards gate pass.

## Follow-ups

- Capture historical #3432 artifacts and reconcile reported run/comment counts with persisted snapshots.
- Giving read-only tools to every reviewer (operator: later option).
- Finding-identity redesign (key includes summary text, `we:scripts/lib/jury-core.mjs:2796`); needs separate evidence.
- Verify whether duplicate dispatch after a completed advisory still occurs once false referrals stop (`we:scripts/conveyor/reconcile-core.mjs`); file only if reproduced.

## Root cause found (orchestrator, 2026-10-02 ~7:30 AM ET)

Decoded the 51 `mandatory-referrals-v1` records on #3432. Each round writes three records under ONE fresh mandatory reviewer id (e.g. a30c21ad at 10:10Z, f6d233a7 at 09:33Z): opened, attempted, then a `not-real` ruling on the same head (495e86acb). The record then says "start a fresh review-pr"; the fresh run opens a NEW record with a NEW reviewer id and EMPTY rulings, and the referral check in we:scripts/lib/jury-core.mjs (around line 2320) reads only the current record's rulings, so the finding is pending again and the tool-less juror re-raises it. Rulings never carry across runs, so the run never reduces to a verdict and the advisory step never posts. Fix: a ruling on the same finding key for the same head carries into later runs (with the independence check still applied to the ruling's own reviewer), and a tool-less juror's finding cannot be CONFIRMED.

## Operator ruling (2026-10-02, via claude-code-chat: "ok")

Add a confirmation turn: when a juror without tools reports a finding as CONFIRMED broken, a tool-bearing verifier gets one turn to reproduce it on the PR head before it counts. Reproduced: it stays CONFIRMED and needs a ruling as today. Not reproduced: it is downgraded to an advisory note and never blocks the run. Cost is paid only when such a claim is made. Giving read-only tools to every reviewer stays a later option, not part of this card.

## Reopened (2026-10-02 ~7:50 AM ET)

The drain marked this card resolved when PR #3477 landed, because that PR's title began "WE 4815:" — but #3477 only added the root cause to the card; nothing was built. Reopened.

Also binding, found when the operator approved #3432 ("I approve 3432", 2026-10-02): the human ceremony itself (we:scripts/review-set-label.mjs --to=clear-human, assertMandatoryReferralsCleared) refuses while the tool-less juror's false referral is pending, and there is no path for the operator to rule on it. The fix must let an explicit operator instruction record the finding-specific ruling (not-real / card / block) on the PR, so a human approval is never deadlocked by a juror's unverifiable claim.
