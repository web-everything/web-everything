---
bornAs: x2udlba
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/conveyor/pr-label-mirror.mjs", "we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs", "we:scripts/conveyor/soak/breaks/mandatory-ruling-ledger-mirror.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/mandatory-ruling-ledger-mirror.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — A test that runs the executor over a LEDGER_EVENTS sink that throws a non-notApplied error and as… (from web-everything/web-everything#5550 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-pr-io.mjs:1610` — A test that runs the executor over a LEDGER_EVENTS sink that throws a non-notApplied error and asserts the review-run row is still recorded or the run outcome is explicit. Or restrict the sink to appending the referral and review-run rows and defer the block sync to a separate effect.
2. `we:scripts/conveyor/pr-label-mirror.mjs:222` — Route all three derives through one helper that takes the facts policy as a parameter. Add a test asserting report and apply plans agree for a non-default repo.
3. `we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs:567` — Extend the guard to flag any non-mirror, non-test source that imports RULING_NEEDED_LABEL or contains the literal 'advisory:ruling-needed' alongside setLabels, --add-label or --remove-label. Put it in check:standards so it does not depend on one test file.
4. `we:scripts/conveyor/pr-label-mirror.mjs:209` — Add a named test: runMirrorApply with a non-default repo and the default facts reader writes nothing, or write the explicit opt-in. Make report and apply share one derive helper so they cannot diverge.
5. `we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs:567` — Replace the regex with a check:standards rule that fails on any non-mirror reference to the label constant or literal in a write context, with a small explicit allowlist (review-set-label removal) so the sole-writer claim is precise.
6. `we:scripts/conveyor/pr-label-mirror.mjs:198` — Add a deterministic first-use test with a provider that rejects additions until the label has been ensured.
7. `we:scripts/conveyor/soak/breaks/mandatory-ruling-ledger-mirror.mjs:88` — Add a deterministic harness test that forces ruling-label drift and asserts the injected writer receives the operation, with production provider creation configured to fail immediately.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5550@a3fcf68c53004d21b9c514a25030ea6b32d87007

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
