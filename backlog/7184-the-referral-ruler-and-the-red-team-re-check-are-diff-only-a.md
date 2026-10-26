---
bornAs: xv5spq2
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The referral ruler and the red-team re-check are diff-only and dismiss real breaks

[held entry 294] (coroner 2026-10-13, held) The referral ruler and the red-team re-check are diff-only and dismiss real breaks. ~7 claims on 5 heads ruled not-real while the ruling conceded the mechanism ("facts are true", "the race path exists"): #5241 e3b5983, #5223 ae2a7ca + 5257ced, #5165 :73, #5184 402b66e; the re-check marked 3 #5187 claims "not in the diff" that were real. Fix idea: ruler + re-check run with the read-only juror tools (REVIEW_JUROR_TOOLS, we:review-pr-io.mjs ~1158 allowedTools:null today); "not-real" refused when the rationale concedes the facts; add a "real, follow-up" answer that files the card itself; "not in diff" = needs-tools, not "not confirmed". Seed precedent prec-5241-conceded-facts-not-not-real. Evidence: scratchpad redteam/rulings.txt. Scope: we:scripts/operations/review-pr-io.mjs, we:review-extra-seats.mjs buildRecheckRequest. Size 3. | [held entry 332] (operator session 2026-10-14 ~16:20 ET, held) Red-team re-check dismisses a real break because the producer is outside the diff. #5243 break #1 (clear-human capture regex lacks /m, so it never matches real review-set-label output) was marked "not confirmed: producer not in diff". The operator then sent the PR back on exactly that break. Fix idea: the re-check juror is tool-bearing and must read cross-file producers/consumers on main before answering "cannot demonstrate"; an "outside the diff" non-confirmation is shown as "unverified", not "not confirmed". Seed precedent: prec-5243-verify-against-real-producer. Coroner: count it as a review miss. | [held entry 356] (coroner 2026-10-14, held — relates 295/332) The red-team re-check has no memory of the thread's earlier confirmations or operator send-backs. #5187 8031184c dismissed the single-digit member break (6182683816) that ec6b37ed had confirmed (6178132754). #5243 245c4054 dismissed the regex at 18:16 ET after the operator's 16:07 ET send-back on it (6179713781). Fix idea: the re-check request carries the thread's confirmed breaks and open operator send-backs. A matching claim is marked confirmed with the prior comment id; it can only be dismissed with a cited fix commit. Evidence: above. Scope: we:scripts/operations/review-extra-seats.mjs (buildRecheckRequest). Size 2.

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
