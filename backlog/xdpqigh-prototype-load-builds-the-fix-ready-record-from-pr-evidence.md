---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/prototype-load.mjs", "we:scripts/worker-brief.mjs"]
dateOpened: "2026-11-01"
tags: []
---

# prototype-load builds the fix-ready record from PR evidence instead of a manual step

Held card 2026-11-01 10:24 ET (#6154). A daemon-fix PR was never prototype-loaded before approval because the worker wrote no fix-ready.jsonl row, so nothing prompted the R1 load. Fix: the loader builds the fix-ready record from PR evidence (green tests, Codex NOT WEAKENED); the review/needs-you event flags a daemon-code PR that is green+audited but not loaded, via a merge-base check.

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
