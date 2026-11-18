---
bornAs: xibozpr
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The drain counts a human-only "held for a human" refusal (#6003) as a failed pass, so it backs off 900 s and d

MED priority hint. - [MED] The drain counts a human-only "held for a human" refusal (#6003) as a failed pass, so it backs off 900 s and delays overlay adoption and all other enqueues by up to 15 min. A human hold should be a skip, not a pass failure (10-29 08:47 ET).

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
