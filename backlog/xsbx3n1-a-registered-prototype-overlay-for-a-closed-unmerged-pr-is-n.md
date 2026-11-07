---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/prototype-load-io.mjs", "we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/daemon-rebuild/plan.mjs", "we:scripts/operations/prototype-retire.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A registered prototype overlay for a CLOSED-unmerged PR is never retired: prototype-load registers with no --…

Flow-sim gap R5a-G4, class K18 (state keyed to an identity never checked for liveness or retraction). Failing input: Registration R of branch lane/x on a daemon clone added through prototype-load (no --pr). PR for lane/x is then CLOSED unmerged, with commits not on main and no merged PR declaring 'Supersedes #N'.' 'Any later daemon rebuild or prototype-load retire step. Cited: we:scripts/operations/prototype-load-io.mjs:573-577, we:scripts/daemon-overlay.mjs:737-745, we:scripts/lib/daemon-load-overlay.mjs:262, we:scripts/lib/daemon-rebuild/plan.mjs:526-532, we:scripts/operations/prototype-retire.mjs:109-117. Soak-break sketch: Fixture: clone overlay list with {ref:'lane/x',pr:null}; gh stub returns the PR list state CLOSED, unique commit not on main, no superseder. Action: run the rebuild plan and planRetirements. Assert: decision remove/retire (or an alert + owner). Fails today: k…

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
