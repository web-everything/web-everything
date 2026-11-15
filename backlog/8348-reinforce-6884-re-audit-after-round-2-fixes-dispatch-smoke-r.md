---
bornAs: xtwpeb4
kind: story
size: 2
status: open
scope: ["we:scripts/operations/prototype-load.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Reinforce #6884: re-audit after round-2 fixes (dispatch-smoke refuse for non-WE repos; daemon-keys test needs safe non-empty repo+clone)

we:scripts/operations/prototype-load.mjs (2026-11-15 10:12 ET, LOW, reinforce-later): re-audit #6884 after the round-2 fixes: dispatch-smoke refuses for non-WE repos, and the daemon-keys test requires a safe non-empty repo and clone.

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
