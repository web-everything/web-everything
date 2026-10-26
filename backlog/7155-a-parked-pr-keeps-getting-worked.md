---
bornAs: xho5ly0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A parked PR keeps getting worked

[held entry 343] (operator ok 2026-10-14 ~20:55 ET, held) A parked PR keeps getting worked. #5223 was parked by the operator at 09:15 ET (replaced by card 307) but stayed open and went through fix rounds, review round 8, ci-heals and an exhausted retry all day. Fix idea: a "parked" state (label or operator ruling via a sanctioned command) that stops all fix/review/ci-heal/drain dispatch and shows under the operator queue as PARKED, with an expiry or a close prompt. Prove: a parked PR gets zero dispatches for a day.

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
