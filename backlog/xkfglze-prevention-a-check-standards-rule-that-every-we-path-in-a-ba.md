---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x2yqhvi-caused-vs-inherited-refusal-split-must-catch-refusals-the-pr.md", "we:backlog/xb8x2qq-merge-re-check-must-never-guess-the-tested-main-commit-from.md", "we:backlog/xujtw7n-delivery-policy-human-review-protection-must-also-cover-json.md"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — A check:standards rule that every we: path in a backlog card's scope either exists or is listed a… (from web-everything/web-everything#3976 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x2yqhvi-caused-vs-inherited-refusal-split-must-catch-refusals-the-pr.md:6` — A check:standards rule that every `we:` path in a backlog card's scope either exists or is listed as created by a blockedBy card.
2. `we:backlog/xb8x2qq-merge-re-check-must-never-guess-the-tested-main-commit-from.md:6` — Hardening-card template or lint: a card with 'Hardens <id>' must declare blockedBy <id> and a scope that is a superset of the hardened card's code files.
3. `we:backlog/xujtw7n-delivery-policy-human-review-protection-must-also-cover-json.md:5` — Same standards rule as above: dependency and scope-existence check for 'Hardens X' cards.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3976@94acd0b7a08cbde4516797e76e0e37e669d57db6

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
