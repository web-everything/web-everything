---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/review-seat-routing.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/settings/review.json", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/lib/__tests__/review-seat-routing.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a readPr io test with an injected exec that asserts the git argv and the commitMessages field… (from web-everything/web-everything#7513 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:474` — Add a `readPr` io test with an injected `exec` that asserts the git argv and the `commitMessages` field. Longer term, a check:standards rule that every new `gitExec` call site in `*-io.mjs` has a matching exec-stub assertion.
2. `we:scripts/operations/__tests__/review-pr.test.mjs:5062` — Add a seat-set parity assertion: mode A and mode B produce the same seat steps and lenses, differing only in the correctness provider.
3. `we:scripts/lib/review-seat-routing.mjs:59` — A table-driven test of `claudeTrailerIn` over the real trailer variants (with and without a model name, parenthesised model, different casing). Relax the regex to `Claude(\s+[^<\n]+?)?\s*<`.
4. `we:scripts/lib/review-seat-routing.mjs:61` — Add a lint or check:standards rule (safe-regex / vuln-regex-detector) over scripts/**, plus a bounded-input test that runs trailer matching on a long whitespace line under a time budget. Alternatively, parse trailers line by line with a length cap.
5. `we:scripts/operations/review-pr.mjs:2693` — Require a test row for each 'only X changes' claim in a seat-routing change, for example a table-driven test over every lens in the mandatory-lens list asserting the vendor.
6. `we:scripts/operations/__tests__/review-pr.test.mjs:5057` — Add the two named regression tests and require an explicit named-test mapping for each acceptance guarantee.
7. `we:scripts/settings/review.json:7` — Add a deterministic test reading the shipped settings with an empty environment and asserting the resulting Codex route.
8. `we:scripts/operations/review-pr-io.mjs:474` — Add a boundary test whose gitExec stub throws for log and whose assertions retain unrelated read fields and the Claude route.
9. `we:scripts/operations/review-pr.mjs:2688` — Add a deterministic checkpoint/resume test that changes routing inputs between runs and asserts the original provider remains selected.
10. `we:scripts/operations/__tests__/review-pr.test.mjs:5043` — Add a named test, 'mode B preserves every mandatory lens', asserting the complete expected mandatory roster for equivalent mode A and mode B reviews.
11. `we:scripts/operations/__tests__/review-pr.test.mjs:5043` — Add a named integration test, 'routed correctness seatTimings reports codex', that asserts the emitted timing label, and record the required live observation separately.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7513@55819a67e31fc79333e2e584f94e26315ca43e25

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
