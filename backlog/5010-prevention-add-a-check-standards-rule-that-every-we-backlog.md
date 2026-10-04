---
bornAs: x5f4lvs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5004-prevention-add-to-the-card-s-must-on-error-list-decline-unle.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a check:standards rule that every we:backlog/... path in a card's scope and body exists on main. Ma… (from chalbert/web-everything#3785 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5004-prevention-add-to-the-card-s-must-on-error-list-decline-unle.md:5` — Add a check:standards rule that every `we:backlog/...` path in a card's `scope` and body exists on main. Make the filer resolve provisional ids to final numbers, or key on the id alone, before writing the card.
2. `we:backlog/5004-prevention-add-to-the-card-s-must-on-error-list-decline-unle.md:24` — Make the filer derive a concrete Done-when from each guard, for example a `grep` or test-name check for each target card edit. Alternatively, gate status:open→in-progress on the TODO being gone. The repo already has 612 such cards, so a lint that blocks the TODO at pickup is the cheapest durable guard.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3785@31ad037e29e0bf96c56df6f3e57f6d62bc90e81e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
