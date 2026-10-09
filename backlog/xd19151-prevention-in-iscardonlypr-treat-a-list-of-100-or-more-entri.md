---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-limit.mjs", "we:scripts/lib/__tests__/pr-limit.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — In isCardOnlyPr, treat a list of 100 or more entries as unknown (not card-only). Add a unit test… (from web-everything/web-everything#4713 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-limit.mjs:78` — In isCardOnlyPr, treat a list of 100 or more entries as unknown (not card-only). Add a unit test for a 100-entry all-backlog list.
2. `we:scripts/lib/pr-limit.mjs:78` — In isCardOnlyPr, treat a files list with length >= 100 (gh's cap) as not card-only. Add a unit test for the cap boundary. Longer term, have a check:standards rule require callers of isCardOnlyDiff to document the input's completeness.
3. `we:scripts/lib/pr-limit.mjs:94` — Add the deterministic throwing-reader test to the test suite, asserting the returned default policy rather than merely that parsing succeeds.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4713@3ed1abd87dcec51a4a1f6781c4782ca1703e862d

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
