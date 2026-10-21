---
bornAs: xmys9a0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/6142-prevention-backlog-prevention-cards-5605-and-5360-already-co.md"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Make the filer skip, or auto-resolve, findings whose text says the guard is already tracked. Alte… (from web-everything/web-everything#5353 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/6142-prevention-backlog-prevention-cards-5605-and-5360-already-co.md:16` — Make the filer skip, or auto-resolve, findings whose text says the guard is already tracked. Alternatively, extend the check:standards placeholder rule so the TODO scaffold fails on open mechanically-filed cards. This would be a new rule, because the existing one only fires beside a mutation-proof claim.
2. `we:backlog/6142-prevention-backlog-prevention-cards-5605-and-5360-already-co.md:15` — Gate prevention-card creation on structured outstanding guard identifiers: when all guards reference existing cards, record provenance there and create no new open card; cover that branch with a deterministic filer regression test.
3. `we:backlog/6142-prevention-backlog-prevention-cards-5605-and-5360-already-co.md:15` — Gate card creation on a structured outstanding-prevention field, and add a deterministic regression test asserting that an already-tracked finding creates no new card.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5353@a77d15f0fee56dce4e1bc906f41ecba2b3b1b4d8

## Acceptance

- [A1] **Executable** — Run from the WE checkout:

  ```sh
  npm run test:unit -- scripts/__tests__/review-set-label.approval-prevention-filing.test.mjs
  ```

  The suite must include a deterministic regression where a finding whose guard is already tracked creates no new open card. Pair it with an untracked finding that creates one card and a retry that creates no duplicate. The already-tracked regression must fail before the filer guard is implemented and pass afterward.

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
