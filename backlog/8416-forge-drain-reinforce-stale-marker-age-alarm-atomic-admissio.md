---
bornAs: x1y1v4u
kind: story
size: 3
status: active
scaffoldedBy: "forge-drain-marker"
dateScaffolded: "2026-11-16"
dateOpened: "2026-11-16"
tags: []
related: ["6935"]
---

# Forge drain reinforce: stale-marker age alarm, atomic admission, no-slot path lock

Reinforce the Forge deploy drain: alarm on a stale marker; make admission atomic with prepared publication; make the legacy no-slot path hold a lock; setup waits on worker-active locks and executing=0, not activeRuns.

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

follow-up to the Forge deploy drain marker PR #6935

no existing card covers the drain marker hardening
