---
bornAs: xmxvm62
kind: story
size: 3
status: open
scope: ["we:scripts/operations"]
dateOpened: "2026-11-15"
tags: []
---

# Sanctioned op to restore the currently adopted overlay set (no new code, no new gates)

2026-11-15 13:28 ET MED: recovering a live loader-made overlay tip (B25) needs audit + waiver + CI test check + soak declaration on an exact sha that was never a PR head: four gates for a pure restore. A sanctioned 'restore the currently adopted overlay set' op (no new code, so no new gates) would have ended the loop in minutes.

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
