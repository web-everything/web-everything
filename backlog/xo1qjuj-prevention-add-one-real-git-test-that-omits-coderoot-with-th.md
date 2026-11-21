---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/queue-branch-numbering.test.mjs", "we:scripts/lib/queue-branch-numbering.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add one real-git test that omits codeRoot, with the fixture clone as the module's location. A sta… (from web-everything/web-everything#7262 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/queue-branch-numbering.test.mjs:1020` — Add one real-git test that omits `codeRoot`, with the fixture clone as the module's location. A standards rule that flags real-git fixtures passing explicit values for newly added defaulted security parameters would catch this class.
2. `we:scripts/lib/queue-branch-numbering.mjs:424` — Add a deterministic regression case for an unassigned, previously absent singleton number below main’s highest, asserting refusal before push while retaining the existing slug-rename success cases.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7262@4a7e488fc5c4440103c339424ba3ff5519b2fa52

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
