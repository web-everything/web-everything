---
kind: story
size: 3
status: open
dateOpened: "2026-11-13"
tags: []
---

# Centralize one any-hold-on-this-head guard (stand-downs, load-flake holds, exhaustion) shared by recovery passes

Build ONE shared "any live hold on this head" guard first (stand-downs of every kind, load-flake holds, redispatch holds, exhaustion), with hold identity: a result or answer resolves only the hold it names, per head, and an unknown or ambiguous result leaves the hold live. Then rebuild the merge-gate input rerun pass (parked branch `lane/merge-gate-rerun-on-input-change`, tip `8d062fde52`) on top of it, and move reconcile-core and load-flake-reverify onto it. Why: five audit rounds on the pass found a new fail-open each time (R88); redispatch results carry no head or hold identity, so a local re-implementation cannot be made safe.

## Acceptance

- [A1] **Executable** — a guard test where a newer other-head hold, and a resolution result for another head, never hide or clear an unresolved current-head hold; it fails on the current `loadFlakeHoldState` (`.at(-1)`) and passes on the new guard.
- [A2] **Executable** — the merge-gate input rerun pass has no hold logic of its own: it calls the shared guard, and the parked-branch tests pass unchanged on top of it.

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

## Known gap (R903)

`loadFlakeHoldState` in `we:scripts/conveyor/stand-down.mjs` takes only the newest hold with `.at(-1)` across all heads. A newer hold for another head hides an unresolved current-head hold. This affects reconcile-core and load-flake-reverify. The merge-gate input rerun pass works around it locally; the centralized guard should fix it at the source.
