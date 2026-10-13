---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5025 (head 8d3f2044f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5025 (reviewed head `8d3f2044f5f4a776320b2c460d9411df37e527e4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-pr-io.mjs:991` — (edge-case, degraded) Negative verification bypasses later-round referral demotion.
   - Scenario: On an unchanged head with a completed referral round (an older we:x.mjs claim independently ruled not-real), judgeAntigravityReview newly reports {file:'we:y.mjs',line:3,summary:'newly raised later-round claim',verdict:'CONFIRMED',impactIfUnfixed:'broken'}. The verifier answers {index:0,reproduced:false,evidence:'we:y.mjs:3 checked the code'}. A probe through the real operation and in-memory referral sink creates another mandatory referral, invokes the referral reviewer, and ends needs-human with that claim pending. With reproduced:true instead, the identical claim is demoted as later-round-referral-sa
   - Claude's re-check: Candidates and verifications are computed before round classification. A not-reproduced claim becomes PLAUSIBLE, so it never enters classifyReferralsByRound. The sink then records it as a disputedAddition (live referral plus ruling attempt), and uncorroboratedRetirements forces needs-human. A reproduced claim stays CONFIRMED and is demoted by round policy, so the two answers diverge.
2. `we:scripts/operations/review-pr.mjs:1357` — (edge-case, degraded) Disabling a seat drops its referral but leaves its negative-verification hold permanently active on that head.
   - Scenario: Persist an unruled judgeAntigravityReview referral with verified:[{key,outcome:'not-reproduced',reason:'we:x.mjs:1 guard holds'}]. Then set REVIEW_PR_ANTIGRAVITY_REVIEW=0 and run a clean review on the same head without that advisory seat. The real sink appends the existing seat-disabled dropped entry, and mandatoryReferralState reports pending:[] and blocked:[]. Nevertheless, the review ends needs-human with confirm.of='human'. A fresh run reading the already-dropped record repeats the hold because shapeReadFinding selects v.outcome before checking activeReferrals. A referral retired by the opera
   - Claude's re-check: shapeReadFinding takes v.outcome from the verified list before it checks activeReferrals, so a dropped referral still yields a not-reproduced row. knownVerifications and uncorroboratedRetirements then emit it from the known map even when no seat raises the claim. That makes acceptHeld true and turns a clean accept into needs-human, although mandatoryReferralState has nothing pending.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
