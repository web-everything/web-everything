---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xul2kwr-a-pr-drafted-as-withdrawn-stays-a-draft-promote-draft-must-n.md"]
dateOpened: "2026-10-02"
tags: []
---

# Prevention — When a card changes a promotion invariant, a card-lint or review lens should grep for other consumers o… (from chalbert/web-everything#3557 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xul2kwr-a-pr-drafted-as-withdrawn-stays-a-draft-promote-draft-must-n.md:5` — When a card changes a promotion invariant, a card-lint or review lens should grep for other consumers of the same predicate (here `isDraft` plus green rollup) and require each in scope or explicitly excluded. Cheapest is a review-lens checklist item, since this is not script-decidable.
2. `we:backlog/xul2kwr-a-pr-drafted-as-withdrawn-stays-a-draft-promote-draft-must-n.md:28` — Require the card's test plan to enumerate every output state of the function being changed (a table of derived state against withdrawal label present). A review lens is the practical guard.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3557@a0469756ac50ade1a5da0f1e1fb72739539f92d5

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
