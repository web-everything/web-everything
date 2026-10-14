---
bornAs: xm3y5se
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a test where the ancestry probe throws status 128 and assert head-mismatch is refused. Altern… (from web-everything/web-everything#5247 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/card-batch-seal-io.mjs:112` — Add a test where the ancestry probe throws status 128 and assert `head-mismatch` is refused. Alternatively, treat an unresolvable recorded head as non-descendant (e.g. `git cat-file -e` first).
2. `we:scripts/operations/card-batch-seal-io.mjs:118` — After the path regex, require that each A/D/M path's card id belongs to state.members or is the rename counterpart of a deleted member card, and cap the count of added cards at policy.maxCards. Add a real-repo test where an unrelated new card is refused. A lint on 'adopt' paths in card-batch-seal-io is not feasible, so a named test is the cheapest durable guard.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5247@0ead1887f4febcc1ae2b83c8be69733a5a508ef8

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
