---
kind: story
size: 5
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs", "we:docs/agent/prototype-based-dev.md"]
dateOpened: "2026-10-18"
tags: []
---

# One prototype branch per daemon so prototypes land and are worked in parallel

Each daemon (drain, review, fix, health-watch, and the others) gets its own prototype branch, overlay and audit, and its own graduation PR, so a slow or failing part for one daemon never holds up another. Cross-daemon changes (for example the drain writes red-team requests that the review daemon reads) declare the dependency and load in order. Evidence (operator 2026-10-18): batch 4 bundled changes for all four daemons on one branch. One audit found 10 weakenings and blocked every fix for about 4 h, including drain-only ones. Batch 5 (drain-only, on its own branch) was audited clean in about 40 min. Scope: we:scripts/daemon-overlay.mjs, we:scripts/lib/daemon-load-overlay.mjs, and the prototype workflow docs. Parent: the parked delivery-modes epic (id contains xc4ft34) is not on main yet, so it is not linked as --parent; link it once it lands.

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
