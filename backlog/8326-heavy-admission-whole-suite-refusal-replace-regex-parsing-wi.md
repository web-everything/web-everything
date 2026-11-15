---
bornAs: xx4wm7h
kind: story
size: 3
status: active
scaffoldedBy: "rt-card-6770"
dateScaffolded: "2026-11-14"
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-14"
tags: []
related: ["6770"]
---

# heavy-admission whole-suite refusal: replace regex parsing with a shell tokenizer

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

Red-team breaks carded on PR 6770: boolean flags before targets wrongly refused (we:scripts/readiness/heavy-admission.mjs:516), prefixed shell expansion bypass (we:scripts/readiness/heavy-admission.mjs:520), chained soak exempts an untargeted suite (we:scripts/readiness/heavy-admission.mjs:740), plus the 2 breaks from the 22:36 send-back. A regex refusal heuristic is best-effort load protection, not a security boundary; the durable fix is a real shell tokenizer.
