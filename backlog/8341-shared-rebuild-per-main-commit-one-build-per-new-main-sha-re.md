---
bornAs: xdnexwg
kind: story
size: 5
status: open
scope: ["we:scripts/daemon-rebuild.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Shared rebuild per main commit: one build per new main SHA reused by every daemon

we:scripts/daemon-rebuild.mjs (2026-11-15 07:05 ET, HIGH, operator-approved; from the delivery simulator command census): rebuilds alone cost 3.45 x merges + 11/day because each daemon rebuilds on its own. Build once per new main SHA and reuse it in every daemon. Measure before/after per-tick CPU-s and RAM from the host sampler as live proof, not unit tests only.

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
