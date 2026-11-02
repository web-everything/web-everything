---
bornAs: xbizhw6
kind: story
size: 2
status: open
scope: ["we:red-team-gate-apply.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# #43 follow-ups after #6257 (digest now covers every finding-shaped line

HIGH priority hint. - (HIGH, 11-02 11:53 ET) #43 follow-ups after #6257 (digest now covers every finding-shaped line; gap REPRODUCED on main): (a) an indented/malformed CONFIRMED finding still does not block (pre-existing) → the gate must treat any unparseable finding-shaped line as a block; (b) legacy gate records without result= bind by thread order, so editing the same comment keeps an old sent-back in force (pre-existing); (c) we:red-team-gate-apply.mjs must WRITE an explicit clear record for a clean result (unblocks #40 v2).

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
