---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/__tests__/stand-down.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a we:stand-down.test.mjs case where the CLI builds a fix-loop-exhausted comment from detail c… (from web-everything/web-everything#5155 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/stand-down.mjs:165` — Add a we:stand-down.test.mjs case where the CLI builds a fix-loop-exhausted comment from detail containing 'Head: <sha>.' and no head. Better, make the legacy prose path apply only to trailer-less bodies, and require a `head=` trailer for every body that has a trailer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5155@5f9b6a4a4bdd84b38e7c67931a275f8b121d4762

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
