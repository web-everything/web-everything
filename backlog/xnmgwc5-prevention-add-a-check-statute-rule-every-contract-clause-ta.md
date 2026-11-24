---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/platform-decisions.md"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a check:statute rule: every contract clause tagged as a guarantee in the store contract must… (from web-everything/web-everything#7310 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/platform-decisions.md:6226` — Add a `check:statute` rule: every contract clause tagged as a guarantee in the store contract must appear in the inventory table. PR 2's `appendIf_contract_case_inventory` is the natural home. Until it lands, add a dedupe-scope row to the planned table.
2. `we:docs/agent/platform-decisions.md:6226` — Add a conformance clause and case saying duplicates are matched on (repo, pr, event id), with a cross-PR same-id negative test. Fold it into the planned appendIf_contract_case_inventory check.
3. `we:docs/agent/platform-decisions.md:6157` — Add a conformance case, or a validator rule in PR 2, that append refuses type merge-intent rows. Cover it with a case in the appendIf inventory.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7310@60110739f43b9fc2fb387e2cbb83f4ed5e2a33c6

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
