---
bornAs: x8ndpc5
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/4656-ci-heal-must-not-delete-the-pr-s-own-intended-change-to-turn.md"]
dateOpened: "2026-09-30"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3168's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4656-ci-heal-must-not-delete-the-pr-s-own-intended-change-to-turn.md:5` — A deterministic check (backlog lint / check:standards) that every non-glob 'we:' path in a card's scope exists on main, or is explicitly marked as new.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3168@0c2dd6e0955504437c77e0bd969797d2cb93e68e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

## Also raised by

- Also raised by web-everything/web-everything#4991 (finding 1: `we:backlog/5921-guard-refuse-the-merge-queue-strategy-while-merge-gate-is-no.md:13` — Backlog-card lint: every repo path in scope or body must exist on main, or the card must declare a dependency on the PR that adds it. Filed as a future check:standards rule.)
- Also raised by web-everything/web-everything#5677 (finding 1: `we:backlog/6466-operator-override-feed-dedups-ended-events-by-their-own-key.md:6` — Add a check:standards rule that every path in a card's scope frontmatter exists on main, or the card declares a dependency on the PR that adds it.)
