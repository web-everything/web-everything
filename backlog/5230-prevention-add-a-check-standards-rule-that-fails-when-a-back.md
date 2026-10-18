---
bornAs: xg28dxx
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5229-prevention-add-a-check-standards-rule-that-fails-on-any-prod.md"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a check:standards rule that fails when a backlog card's scope entries do not resolve to track… (from web-everything/web-everything#4168 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5229-prevention-add-a-check-standards-rule-that-fails-on-any-prod.md:6` — Add a check:standards rule that fails when a backlog card's `scope` entries do not resolve to tracked files. Entries marked as new files would be exempt.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4168@2cd73cb066d5d98b26bf0ffaace40de602b89233

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Also raised by

- Also raised by web-everything/web-everything#5268 (finding 2: `we:backlog/5028-drain-and-lander-must-not-resolve-a-landed-card-whose-blocke.md:33` — Add a check:standards rule that fails when a backlog card's scope lists a test file that the Test plan never mentions.)
- Also raised by web-everything/web-everything#5566 (finding 1: `we:backlog/xubk7yg-prevention-extend-the-card-to-test-mapping-check-so-every-mu.md:5` — Add a check:standards rule that warns when a backlog card's scope: entries do not resolve on the base branch.) · key `approval-prevention-key:web-everything/web-everything#5566@68f070076b3e31b3d0333e43a3207459a9358362`
