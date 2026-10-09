---
bornAs: xbk1pf8
kind: story
size: 2
status: open
dateOpened: "2026-10-09"
tags: []
---

# Require order-spy evidence for ordering and atomicity comments in review

An ordering comment can remain persuasive while the code violates its guarantee. Add a review-lens checklist requirement to connect each ordering or atomicity justification to a test of the real call order and, when durability is claimed, the observable persisted boundaries.

## Design

- Add the requirement to the applicable correctness review lens after locating its canonical source. Comments that justify one effect preceding another must name an order-spy test; durable-exclusion claims also need persisted-state evidence.
- Use #4410 as the motivating example: `settleTerminal` in we:scripts/operations/deliver-item-wrapper.mjs previously justified hold-before-release while settlement could let the daemon retire the claim first. The regression in we:scripts/operations/__tests__/deliver-item-wrapper-ordering.test.mjs demonstrates the missing boundary.
- Require reviewers to distinguish successful persistence from a swallowed exception or an unsuccessful return value. Avoid treating a final-state assertion as evidence about interruption between writes.

## Done when

The canonical review checklist requires concrete order evidence for ordering/atomicity comments, names the #4410 example, and a review prompt fixture demonstrates the requirement reaches the reviewing actor. Implementing the checklist belongs to this card, not #4410.
