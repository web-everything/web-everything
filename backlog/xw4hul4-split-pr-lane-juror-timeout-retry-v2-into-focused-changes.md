---
kind: story
size: 3
status: open
scope: ["we:docs/agent/testing.md", "we:scripts/conveyor/review-referral-hold.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/reviewJurorTimeoutRetry.json", "we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/juror-timeout-route.mjs", "we:scripts/operations/review-builder.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/settings/review.json", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Split PR lane/juror-timeout-retry-v2 into focused changes

size-split-key:808d155dd489e10f2b218a441a25bb3622ff62d27915de954574e1af387db948. Plan follow-up splits for PR lane/juror-timeout-retry-v2. File groups: we:docs/agent: 4; we:scripts/conveyor: 34; we:scripts/lib: 6; we:scripts/operations: 230; we:scripts/settings: 1; we:skills-src/conveyor: 26

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
