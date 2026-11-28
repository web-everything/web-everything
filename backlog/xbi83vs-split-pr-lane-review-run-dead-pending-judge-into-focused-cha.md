---
kind: story
size: 3
status: open
scope: ["we:docs/agent/platform-decisions.md", "we:scripts/conveyor/session-reaper.mjs", "we:scripts/conveyor/soak/breaks/index.mjs", "we:scripts/conveyor/soak/breaks/review-run-dead-pending-judge.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/reap-dead-review-runs.mjs", "we:scripts/lib/repo-scan-tests.mjs", "we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/review-run-reap-job.mjs", "we:scripts/lib/run-abandoned.mjs", "we:scripts/lib/settings-registry-metadata.d/settings/reviewRunReaper.json", "we:scripts/operations/review-job-store.mjs", "we:scripts/settings/review-run-reaper.json", "we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Split PR lane/review-run-dead-pending-judge into focused changes

size-split-key:bd309b8a066bf77b252a0f2adf6acd277aca1c6e533d7f394325544d182873ef. Plan follow-up splits for PR lane/review-run-dead-pending-judge. File groups: we:docs/agent: 25; we:scripts/conveyor: 113; we:scripts/lib: 255; we:scripts/operations: 5; we:scripts/settings: 3; we:skills-src/conveyor: 18

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
