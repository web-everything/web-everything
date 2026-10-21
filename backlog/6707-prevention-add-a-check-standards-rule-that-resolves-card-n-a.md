---
bornAs: xbp6b9r
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xpwakvl-operator-controls-tie-actor-to-the-authenticated-identity.md"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a check:standards rule that resolves "card N" and "#N" references in backlog card bodies to a… (from web-everything/web-everything#5397 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6161-operator-controls-tie-actor-to-the-authenticated-identity.md:10` — Add a check:standards rule that resolves "card N" and "#N" references in backlog card bodies to an existing card. It should warn when the target is resolved and its title shares no terms with the surrounding sentence. File this as a future backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5397@051b61d65f3d515b5a8e0c55ad8598e49fdfa614

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
