---
kind: story
size: 3
status: open
scope: ["we:docs/agent/settings-registry.md", "we:docs/agent/testing.md", "we:scripts/lib/agy-review-juror.mjs", "we:scripts/lib/agy-shadow-trial-report.mjs", "we:scripts/lib/dispatch-routing-policy.json", "we:scripts/lib/review-carbon-promotion.mjs", "we:scripts/lib/review-seat-provider.mjs", "we:scripts/lib/review-seat-settings.mjs", "we:scripts/lib/review-shadow-agreement.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/operations/review-seat-runner.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-11-21"
tags: []
---

# Split PR lane/agy-carbon-promotion into focused changes

size-split-key:52e0aead43765f3a11a1a744508f649e6f52ebb6648b3713d37619ae80e86270. Plan follow-up splits for PR lane/agy-carbon-promotion. File groups: we:docs/agent: 31; we:scripts/lib: 209; we:scripts/operations: 133; we:scripts/settings: 8

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
