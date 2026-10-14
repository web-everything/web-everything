---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/native-github-review.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5223 (head 5257ced00)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5223 (reviewed head `5257ced00a2d2f8ceb2dfbf6e692f6cd238e6f88`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/native-github-review.mjs:675` — (edge-case, degraded) Concurrent mirrors of the same verdict post duplicate native reviews.
   - Scenario: Two reviewer-App runs mirror accepted for owner/repo PR 123 at head 'a'.repeat(40), with live review:accepted and initially empty review history. A reads the empty history and pauses before POST. B reads the same history, posts APPROVE, and finishes. A resumes and also posts APPROVE; settlement checks labels but does not remove or prevent the duplicate. An injected-I/O probe returned outcome=posted for both runs and recorded two APPROVE reviews. Expected: the promised idempotency per PR/head/verdict permits one native review, with the other run recognizing the existing submission.
   - Claude's re-check: Idempotency is a check-then-act: readReviews runs before the POST, with no lock or re-check. Two runs that both read an empty history both POST APPROVE. settleOnLiveVerdict only compares labels, so it returns null and both report 'posted'.

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
