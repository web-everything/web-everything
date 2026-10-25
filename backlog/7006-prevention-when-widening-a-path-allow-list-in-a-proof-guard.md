---
bornAs: x6qfajh
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/numbering-carry.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — When widening a path allow-list in a proof guard, add one agent-doc test that exercises each stat… (from web-everything/web-everything#5876 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/numbering-carry.test.mjs:81` — When widening a path allow-list in a proof guard, add one agent-doc test that exercises each stated invariant (bornAs kept, mode unchanged, unchanged-content refusal), e.g. by running the existing backlog invariant tests over both path families with `it.each`.
2. `we:scripts/lib/__tests__/numbering-carry.test.mjs:81` — Add the named regression test to the automated test gate, pairing rejection of changed bornAs with acceptance when bornAs remains unchanged.
3. `we:scripts/lib/__tests__/numbering-carry.test.mjs:81` — Add a named regression test containing both an ordinary mapped reference and a bornAs line; assert acceptance when bornAs is preserved and refusal when it is rewritten, and run it in the existing test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5876@8102490fea3e7fef347cb2a38f758b68f416f803

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
