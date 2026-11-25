---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/review-shadow-budget.test.mjs", "we:scripts/operations/review-seat-runner.mjs", "we:scripts/lib/review-shadow-budget.mjs", "we:scripts/lib/agy-review-juror.mjs", "we:scripts/lib/__tests__/agy-review-juror.test.mjs", "we:scripts/operations/__tests__/review-seat-runner.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a contract test that feeds a real runAgyReviewJuror voided result (the fixture transcript) in… (from web-everything/web-everything#7471 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/review-shadow-budget.test.mjs:193` — Add a contract test that feeds a real runAgyReviewJuror voided result (the fixture transcript) into runSeatWithProvider and asserts one release, or have the juror return a structured void kind that both sides use. File it with AGY-CARBON-SEATS-HARDEN.
2. `we:scripts/lib/__tests__/review-shadow-budget.test.mjs:159` — Under AGY-CARBON-SEATS-HARDEN, save a real voided transcript as a juror test fixture and record the live void-rate check as that card's acceptance.
3. `we:scripts/operations/review-seat-runner.mjs:102` — Decide eligibility from structured data (for example a flag set when every offending call is read_file) instead of parsing the reason text, with table tests for multiple steps and bracketed names.
4. `we:scripts/operations/review-seat-runner.mjs:98` — Reword to say the run produced no usable answer and still consumed model time. A review lens is enough, as this is not script-decidable.
5. `we:scripts/lib/review-shadow-budget.mjs:38` — Add a stale-release case with dailyCap >= 2, so refund budget remains and only the token check can refuse. As a class gate, require a mutation check for each guard named in a 'cannot' comment.
6. `we:scripts/operations/review-seat-runner.mjs:102` — Feed the runner test reasons produced by the juror for a mixed transcript, or better, return a structured void code from the juror instead of regex-matching prose.
7. `we:scripts/operations/review-seat-runner.mjs:102` — Capture a real voided transcript as a fixture under the HARDEN card and add a named replay test, plus a void-rate check on shadow rows.
8. `we:scripts/operations/review-seat-runner.mjs:51` — Ship the refund behind a default-off setting that the HARDEN card flips, or set WE_REVIEW_SEAT_CAP_CARBON_SHADOW=0 until then, and correct the stale comment and doc.
9. `we:scripts/lib/agy-review-juror.mjs:325` — Reduce echoed names to an allowlist such as [A-Za-z0-9._-] and add a test with a newline and @ in the path; ideally one shared helper for any transcript-derived text placed in reasons.
10. `(no file cited)` — Add a deterministic acceptance-mapping gate requiring every acceptance item to reference a named implemented or planned check with observable assertions.
11. `we:scripts/lib/review-shadow-budget.mjs:39` — Add a deterministic concurrent-release regression test that interleaves replacement between validation and unlink and asserts the newer reservation survives; the supplied HARDEN gate identifies the atomicity fix.
12. `we:scripts/lib/review-shadow-budget.mjs:39` — Gate releases with regression cases for token prefixes, suffixes, and timestamp substrings; exact matching is already identified in HARDEN, but these tests are not supplied.
13. `we:scripts/operations/review-seat-runner.mjs:103` — Add a table-driven refund test using valid filenames containing diagnostic delimiters, or gate refunds on a structured reason code.
14. `we:scripts/lib/__tests__/agy-review-juror.test.mjs:468` — Require an absolute-path regression case with exact output assertions for the basename-only guarantee.
15. `(no file cited)` — Require each acceptance item to reference a named implemented or planned check with explicit observable assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7471@6d048b30492069cf7f383262d7cad355b5944d1a

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
