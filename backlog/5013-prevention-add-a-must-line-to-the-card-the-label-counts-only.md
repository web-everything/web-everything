---
bornAs: x9kzun8
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5005-a-pr-that-fixes-red-main-is-exempt-from-the-main-red-hold.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a Must line to the card: the label counts only if applied by an allow-listed actor (verified via th… (from chalbert/web-everything#3836 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5005-a-pr-that-fixes-red-main-is-exempt-from-the-main-red-hold.md:16` — Add a Must line to the card: the label counts only if applied by an allow-listed actor (verified via the labeling event actor), and the diff path should require the diff to be confined to files in the failing output. Add a card-lint rule that a card loosening a hold or refusal must carry Must lines for the trust source and the failure mode.
2. `we:backlog/5005-a-pr-that-fixes-red-main-is-exempt-from-the-main-red-hold.md:18` — A check:standards rule that rejects open cards with a literal 'TODO:' in Done-when, and requires Must lines when the card's text describes exempting or loosening a hold or refusal.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3836@65c04ed0944b54846a582c8aa2b0cd2eda7ccd2c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
