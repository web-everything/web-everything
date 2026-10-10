---
bornAs: xe33dut
kind: story
size: 3
parent: "2405"
status: resolved
scaffoldedBy: "ledger-e2"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-09"
graduatedTo: 2848bc36d4a07bb646f59988bd340c5e29ac3efd
tags: []
---

# Ledger plan slice E2: a review run appends referral and review-run events

A review-pr run appends a referral event and a review-run event (posted yes/no) to the verdict ledger, alongside the unchanged comments, labels and decisions. A ledger write miss follows the statute write-miss posture.

## Done when

1. **Executable** — `npx vitest run we:scripts/operations/__tests__/review-pr.test.mjs we:scripts/operations/__tests__/review-pr-io.test.mjs`: a #3988 replay of 3 runs on one head yields 3 `review-run` rows with `posted:false`, and a run that opens referrals also yields one `referral` row with its finding keys.
2. **Must** — comments, labels and decisions are byte-identical to today; the ledger rows are written alongside only.
3. **Must** — a ledger write miss never throws and never blocks the run: it prints a loud `ledger-write-miss` line and the run goes on (the statute write-miss posture, `#verdict-ledger-pr-state-store` rule 4; both events are non-clearing).

## Edge cases this change must handle

1. **Untrusted text** — finding keys are stored as a sha256 of the key, never as raw finding text.
2. **Truncated reads** — n/a: the writer reads no ledger.
3. **Shared state files** — rows go through `appendVerdict` (lock plus git transport); no new file.
4. **Fail closed** — n/a: both events are non-clearing; a miss is loud, not a hold change.
5. **Identity scoping** — rows carry repo, PR and the reviewed head sha.
6. **State over time** — append-only; a replayed step may add a second row, which only raises a visit count.
7. **Who wrote it** — `source: review-pr`, actor is the current session id.
