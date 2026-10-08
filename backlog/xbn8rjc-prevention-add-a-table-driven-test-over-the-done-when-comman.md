---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/prep-review.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/prep-review-io.mjs", "we:scripts/conveyor/__tests__/prep-review.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/conveyor/__tests__/prep-review-io.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Add a table-driven test over the Done-when commands in existing backlog cards that asserts execut… (from web-everything/web-everything#4453 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/prep-review.mjs:88` — Add a table-driven test over the Done-when commands in existing backlog cards that asserts `executableCommands` is non-empty for each. This is cheap to write and catches allowlist gaps. Alternatively, loosen the rule to any backticked span containing a space.
2. `we:scripts/merge-ai-prs.mjs:2927` — In reviewCoverageGaps, accept a prep-advised record only when its marker head equals the PR's current head sha. Have the stage remove review:prep when a labelled PR is no longer card-only. Pin both with a test: note, then push a code file, expect no-recorded-review and the label stripped.
3. `we:scripts/conveyor/prep-review.mjs:260` — Add a per-PR round ceiling that stops model spend after N rounds, and require the PR author to be automation or operator (isTrustedMarkerAuthor on the PR author) before spending a model call. Pin it with a test of 4 heads giving at most 1 or 2 model calls.
4. `we:scripts/conveyor/prep-review.mjs:321` — Add a deterministic lifecycle test that carries the actual first-round labels into a new-head review and asserts removal of the prep-owned review:changes label.
5. `we:scripts/conveyor/prep-review.mjs:348` — Add a deterministic test with more than three eligible PRs and a throwing postComment provider; assert that judge is called at most three times, and account for expenditure independently of publication success.
6. `we:scripts/conveyor/prep-review-io.mjs:30` — Add deterministic adapter tests using the injected exec function to pin rejected inputs, exact arguments, byte limits, and read-error propagation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4453@3c8823652deb5e3595bbe30236849f2431e8e576

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
