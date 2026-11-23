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

Implement deterministic acceptance-map validation in the standards/PR-body gate, with named fixtures:

| Planned fixture | Observable outcome |
| --- | --- |
| `retry-single-tick-rejected` | A retry/deduplication guarantee with only the initial failure tick is rejected for missing a later observation. |
| `retry-later-window-accepted` | The PR #7336 failed-release/claim-race examples at +31, +60 and +90 minutes satisfy temporal evidence. |
| `acceptance-unmapped-rejected` | One of four numbered acceptance items without a test or operational check id is rejected. |
| `acceptance-carded-without-id-rejected` | The literal claim “carded” without an existing card id and an assigned owner is rejected. |
| `acceptance-pending-live-not-complete` | A mapped live check without recorded observations remains pending; a passing unit count cannot complete it. |
| `acceptance-complete-map-accepted` | Every numbered item maps to an existing named check and observable result (or an explicitly pending owned card). |
| `non-temporal-negative-accepted` | A single-call malformed-input rejection is accepted without extra ticks merely because its title says “never”. |
| `default-writer-needs-default-io-smoke` | A consumer enabled by default in production but disabled under tests needs a named default-IO smoke; injected recovery IO alone is rejected as proof. |
| `waiver-card-id-missing-rejected` | A waiver citing a nonexistent backlog id, or omitting its id, cannot count as tracked. |

These are planned fixtures, not implemented checks. Record the gate command, fixture name and diagnostic for each before closing this card. The broader temporal review rule needs fixture checks as well as machine-checkable acceptance mappings.

## Recovery-only gate prevention

PR #7336's 2026-11-23 park regression is covered by `consumer preserves ordinary planner rows under a %s recovery gate`, `consumer preserves the real planner ci-heal row for a red draft on later ticks`, and `the CI-heal consumer launches the real planner row for a red draft with recovery enabled` in `we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs`. Require equivalent consumer contract tests whenever a recovery-only refusal can filter the ordinary plan: include draft, non-open and referral holds, existing episodes, unrelated kinds, and later ticks. The `ordinaryParkedRows` soak scenario covers both repair consumers. Verification of this repair remains with the launcher gate.
