---
kind: story
size: 3
status: open
dateOpened: "2026-11-25"
scope: ["we:scripts/conveyor/__tests__/", "we:docs/agent/reviewer-expectations.md"]
tags: [prevention]
---

# Require assertions for fields stripped by test normalizers

The no-code tests compared dispatch rows after stripping `operatorAnswer`, so deleting the production payload filter left them green. PR #7480 now asserts absence of the property on ordinary dispatch rows in incident replays and stale-ruling cases. Apply this protection to other normalized comparisons.

## Acceptance

- A review lens or targeted mutation check inventories fields removed by test normalizers and requires a separate semantic assertion for each meaningful field.
- The no-code incident tick-two `ci-heal` and stale-ruling `fix` tests fail if the production `!isNoCodeRearmAnswer(operatorAnswer)` filter is removed.
- Keep positive assertions for ordinary operator answers so the guard cannot pass by dropping every answer.

## Origin

PR #7480 review, 2026-11-25: correctness/coverage finding 1, security/test-coverage finding 1, and simplicity/codex advisory payload suggestions. Immediate assertions are in `scripts/conveyor/__tests__/no-code-rearm.test.mjs` and both no-code soak scenarios.
