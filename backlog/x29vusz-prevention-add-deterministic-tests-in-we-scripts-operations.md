---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/stand-down-answer.md", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add deterministic tests in we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs nam… (from web-everything/web-everything#7514 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/stand-down-answer.md:83` — Add deterministic tests in we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs named 'aged live owner remains exclusive' and 'proven dead owner permits recovery', asserting acquisition refusal and successful acquisition respectively; alternatively identify existing named tests defending those guarantees.
2. `we:scripts/operations/promote-draft-pr-dispatch.mjs:191` — Add a deterministic default-lock lifecycle test covering live, unknown, and proven-dead ownership, including a live holder beyond any nominal expiry.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7514@05b45a040cd3765ff77d22c43d9ab38a73d1e0fa

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
