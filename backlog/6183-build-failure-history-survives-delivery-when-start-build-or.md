---
bornAs: x3t6b43
kind: story
size: 3
status: open
scope: ["we:scripts/operations/start-build.mjs", "we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/hermetic-tests.settings.json"]
dateOpened: "2026-10-16"
tags: []
---

# Build-failure history survives delivery when start-build or a grouped build releases the claim

Red-team follow-up from PR #5453: observed delivery must clear a card's build-failure ledger row (we:scripts/conveyor/build-dispatch-failures.mjs#clearBuildFailure). Two release paths still skip it: (1) we:scripts/operations/start-build.mjs#settleDeadJob releases a dead job's build claim (status ended = process gone, no verdict) with no delivery check and no clear, so a worker that opened a PR and died keeps its prior failures and a later failure can exhaust the card; (2) group members delivered by the lead's PR are never cleared, because the retire loop in we:skills-src/conveyor/build-dispatch-daemon.mjs only matches the PR's own num. Also add clearFailure to the adoptOrphanedBuildClaims requires list in we:scripts/hermetic-tests.settings.json so no test reaches the host ledger through the new default.

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
