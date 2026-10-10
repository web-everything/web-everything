---
bornAs: xvwzqi0
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5102-prevention-when-the-card-is-groomed-require-the-done-when-to.md"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Make the approval-time prevention filer resolve we:backlog/bornAs-*.md paths to the current NNNN-… (from web-everything/web-everything#3830 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5102-prevention-when-the-card-is-groomed-require-the-done-when-to.md:6` — Make the approval-time prevention filer resolve `we:backlog/<bornAs>-*.md` paths to the current `NNNN-` filename, or fail if the path does not exist. A `check:standards` rule could also assert that every `scope` entry of the `we:` form exists on disk.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3830@5dbb97875768544344368071250e485f1b43ebb2

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

## Also raised by

- Also raised by web-everything/web-everything#4811 (finding 1: `we:backlog/xss4m4n-prevention-a-checklist-or-review-bot-that-cross-references-e.md:4` — Have the approval-time prevention filer resolve each cited we:backlog/x… slug to its current numbered filename or drop paths that don't exist before writing scope: . Add a check:standards rule that every scope: entry of a backlog card must exist.)
