---
kind: story
size: 3
status: active
scaffoldedBy: "fix-5242"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/operations/operator-task-brief.mjs", "we:scripts/backlog/operator-task.mjs", "we:scripts/lib/operator-task-settings.mjs", "we:scripts/settings/operator-task.json"]
dateOpened: "2026-10-15"
tags: []
---

# verify operator-task authority before post-build steps run

Split out of PR 5242 by the operator (send-back 2026-10-15 ~10:25 ET). PR 5242 ships the operator-task brief tooling with the edge-load and live-proof post-build steps switched OFF for every card: planOperatorPostBuild in we:scripts/operations/operator-task-brief.mjs never emits them. This card owns the authority work needed to turn them back on.

## Design
Gate post-build steps on an operator-task status that is verified by a recorded operator instruction, not on card frontmatter the card author can write. The current operatorInstruction record (actor, channel, at, words) is self-asserted: anyone who can edit a card can write it. Decide what makes the record verifiable (for example a durable operator-authored marker, like clear-human, that the dispatcher reads from a source the card author cannot write) and read it in planOperatorPostBuild. Re-decide build.operatorTask.enabled as part of the same gate.

## Done when
- planOperatorPostBuild emits edge-load and live-proof steps only for a card whose operator status is verified from a recorded operator instruction outside the card author's control.
- build.operatorTask.enabled and the postBuild leaves gate those steps as documented in we:docs/agent/backlog-workflow.md.
- The PR 5242 review finding on we:scripts/operations/operator-task-brief.mjs line 16 (the steps depend on self-asserted operatorTask frontmatter) is resolved.
- renderOperatorEdgeStep and renderOperatorProofStep are wired back into planOperatorPostBuild, and the postBuild defaults in we:scripts/lib/operator-task-settings.mjs and we:scripts/settings/operator-task.json are revisited.

## Edge cases
- A card that copies a real operator record from another card.
- A record whose actor is a valid operator login but which no operator ever posted.
- Operator login lists that differ per process (WE_OPERATOR_LOGINS).
- Grouped builds, which already refuse operator post-build steps.

## Test plan
Unit tests in we:scripts/operations/__tests__/operator-task.test.mjs: a forged or copied record composes no edge-load or live-proof step; a verified record composes them; enabled=false composes none.

## Proof plan
Dispatch a real operator card with a verified record and an edgeClone, and show the composed brief carries the edge step; show a card with a hand-written record does not.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
