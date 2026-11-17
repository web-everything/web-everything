---
bornAs: xbfmv8l
kind: story
size: 5
status: open
scope: ["we:scripts/readiness/forge-exec-manifest.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["8233"]
---

# Forge private-key detector: structural decode layer A plus label/run layer B (S1+S2)

we:scripts/readiness/forge-exec-manifest.mjs (2026-11-15 03:28 ET, HIGH, hard line): build S1 and S2 of we:designs/forge-key-structure.md, a decode-based structural Layer A plus a label/run Layer B, additive over main. PR #6748 was parked as weaker than main. Prove on the live case with before/after evidence, not only unit tests.

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

adjacent but distinct

different failure/behaviour
