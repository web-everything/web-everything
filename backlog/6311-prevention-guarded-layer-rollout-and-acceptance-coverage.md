---
bornAs: x3g7q2m
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/check-backlog-item.mjs", "we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs", "we:scripts/__tests__/check-backlog-item.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-18"
tags: [prevention, backlog, acceptance]
---

# Prevention: check guarded-layer rollout dependencies and named acceptance coverage

Prevent the specification gaps raised in PR #5549's 2026-10-18 advisory: an override layer could activate before its guard floor, while safety, hostile-text, temporal-state and production-wiring guarantees had no named acceptance tests. The immediate card repairs are in 6264–6267 and 6269; this story supplies the durable template and lint checks.

Extend the card template with explicit mappings from each handled edge-case line to a named test under A1. Require a “State over time: supersession and removal” line for append-only stores with derived views, and require production caller coverage when a new optional hook defaults to null. Use structured references for the mechanical checks; a review checklist checks prose guarantees that cannot be decided mechanically. Every named test mentioned elsewhere in a card must also appear in A1. “Untrusted text”, “State over time” and “Identity scoping” guarantees must map to tests that identify the relevant behavior, including hostile input, entry-bound confirmation, expiry and supersession.

Add an explicit activation/guard-floor reference to the template for settable configuration layers. A card declaring activation must name its floor card in blockedBy; where visibility is part of the guard contract, it must also name the attention-feed card. Check blocker existence and cycles. Reviewers must check that cards whose bodies activate a layer actually declare this metadata, so omitting the metadata cannot silently bypass the rule.

For caller wiring, require a named integration test that imports production assembly and observes the injected hook at every call site. Constructing the callee inside its own unit test is insufficient. Name tests for trust filtering, normalization and reservation/spawn failure recovery. Review mutation evidence must show that deleting the argument at each production call site fails that integration test.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` on we:scripts/__tests__/check-standards-rules-backlog-integrity.test.mjs and we:scripts/__tests__/check-backlog-item.test.mjs. Add fixtures with these named tests:
  - `an activating settable-layer card without its declared guard floor in blockedBy is rejected`
  - `an activating layer that promises visibility must block on its attention-feed card too`
  - `missing blocker references and cyclic rollout dependencies are rejected`
  - `each handled edge case and every prose-named test maps to an A1 named test`
  - `untrusted-text handling without a named hostile-input acceptance test is rejected`
  - `state-over-time and identity-scoping guarantees require named supersession removal and entry-bound confirmation tests`
  - `an optional production hook requires caller-wiring trust normalization and failure-recovery acceptance tests`
  - `a complete card and an explained n/a edge case pass the scoped and whole-repo rules equally`
- [A2] Review the template against 6264–6267 and 6269. Show that removing the floor blocker or a hostile-text/entry-binding/caller-wiring test produces an actionable diagnostic or explicit checklist failure. Document which checks are mechanical and which require review judgment.

## Non-goals

- [N1] Does not implement the operator-override layer or retry job, and does not infer arbitrary behavioral correctness from a test's name.
- [N2] Does not require historical resolved cards to adopt the new template retroactively.

## Edge cases this change must handle

1. **Untrusted text** — card bodies and test names are parsed as data, never evaluated; hostile-input requirements map to the A1 fixture test above.
2. **Truncated reads** — malformed or incomplete card metadata produces a diagnostic rather than a successful omission (missing-reference fixture).
3. **Shared state files** — n/a: lint reads card files and never writes queue or coordination state.
4. **Fail closed** — declared activation with an absent guard reference fails lint; undeclared prose activation is an explicit review check (A2).
5. **Identity scoping** — resolve exact card IDs and named-test references within the card; do not borrow coverage from another card (A1 mapping fixture).
6. **State over time** — template adoption applies to new or edited open cards; resolved historical cards remain readable (A1 complete-card fixture).
7. **Who wrote it** — prevention owed by the PR #5549 advisory, not a change to its human-review verdict.
