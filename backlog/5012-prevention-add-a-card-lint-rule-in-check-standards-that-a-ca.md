---
bornAs: xi6h43m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5006-required-checks-are-hermetic-a-github-outage-or-rate-limit-n.md"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Add a card-lint rule, in check:standards, that a card whose text loosens a gate (neutral, skip, or fail… (from chalbert/web-everything#3837 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5006-required-checks-are-hermetic-a-github-outage-or-rate-limit-n.md:15` — Add a card-lint rule, in check:standards, that a card whose text loosens a gate (neutral, skip, or fail-open wording) must contain a Must line naming the error-path behaviour. The card's own hint already says this in prose.
2. `we:backlog/5006-required-checks-are-hermetic-a-github-outage-or-rate-limit-n.md:15` — Run a workflow-lint (for example actionlint or zizmor, or a check:standards rule) that rejects github.event.*.body interpolated into run: blocks, and requires `edited` among the pull_request types for gates that read the body.
3. `we:backlog/5006-required-checks-are-hermetic-a-github-outage-or-rate-limit-n.md:19` — Reject cards with a literal "TODO:" in Done-when at filing time, via a check:standards rule.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3837@1c76b3b4f0de2553cfaa42e9fa8c693a8578feaa

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
