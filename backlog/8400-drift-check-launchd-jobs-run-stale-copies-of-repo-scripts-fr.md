---
bornAs: xl1rzw2
kind: story
size: 3
status: active
scaffoldedBy: "cards-batch-21"
dateScaffolded: "2026-11-16"
scope: ["we:scripts/conveyor/health-smells/"]
dateOpened: "2026-11-16"
tags: []
related: ["3681"]
---

# Drift check: launchd jobs run stale copies of repo scripts from the ops handoff dir

B3 root cause: launchd jobs run COPIES of repo scripts from the ops handoff directory. we:scripts/conveyor/sync-guard-clone.mjs was 3 days stale, so #6800 and #6888 never took effect. Add a drift check (health smell) comparing each launchd-run ops copy with its origin/main source, or run the jobs from a stable synced checkout.

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

## Duplicate admission

daemon staleness detection
