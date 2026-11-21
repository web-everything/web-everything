---
kind: task
status: open
scope: ["we:scripts/capability-search.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Reinforce the #7269 trial: narrow plateau terms, strict placement parsing, restrict --out

#7269 trial reinforce-later items: narrow the plateau terms (review and gate pushes pushed plateau-app routing to 68%), parse explicit placement strictly, restrict --out. The PII-flow card was misrouted to plateau-app. Source: build-queue 22:15 ET 2026-11-20.

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

new card from build-queue CARD line
