---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:MISSING_BLOCKS.md"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a deterministic documentation gate, with a named test such as test_missing_blocks_required_entries_an… (from plateauapp/plateau-app#234 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:MISSING_BLOCKS.md:206` — Add a deterministic documentation gate, with a named test such as test_missing_blocks_required_entries_and_fields, asserting the 11 expected headings and each entry's five required fields.
2. `we:MISSING_BLOCKS.md:206` — Add a deterministic documentation check that asserts the expected entry identifiers and required nonempty fields.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#234@2da7ded38c1db2db548d9c83b638452fdd9649ad

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
