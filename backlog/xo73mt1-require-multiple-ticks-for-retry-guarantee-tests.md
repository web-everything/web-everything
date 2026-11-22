---
kind: task
status: open
dateOpened: "2026-11-22"
tags: [conveyor, testing]
scope: ["we:docs/agent/reviewer-expectations.md", "we:docs/agent/testing.md"]
---

# Require later-tick assertions for retry guarantees

The security coverage finding on PR #7336 asks for a review-lens or lint rule so a test named cannot, never or second does not establish a temporal guarantee from a single tick. The repair adds failed/throwing-release and claim-race assertions across later ticks; this card tracks the broader prevention rule.

## Acceptance

- Add a review check requiring at least two observed ticks when a named guarantee concerns retries or deduplication, including assertions after the failure window.
- Require each numbered acceptance item to cite a named automated test or operational check and its observable assertion before it can be marked complete.
- Review examples that incorrectly claim temporal or live evidence and examples that correctly distinguish simulation from operational proof; avoid imposing repeated ticks on non-temporal tests solely because of a word in the title.

## Proof plan

Validate the rule on the PR #7336 claim-race and failed-release examples, plus a non-temporal negative test, and record the resulting review findings.
