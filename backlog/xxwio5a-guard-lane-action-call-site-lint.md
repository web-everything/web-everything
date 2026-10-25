---
kind: task
status: active
scaffoldedBy: "fix-5759"
dateScaffolded: "2026-10-24"
dateOpened: "2026-10-24"
tags: []
---

# Check that every destructive lane action goes through guardLaneAction

PR 5759 advisory (security/coverage): guardLaneAction in we:scripts/lib/health-watch-lane-scan.mjs is the required fresh-safety gate for lane reclaim, reset, reuse and release, but nothing calls it and no test or lint ties real destructive call sites to it. Add a check:standards rule or an allowlist test of known call sites that flags any lane reclaim/reset/reuse/release not routed through guardLaneAction.

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
