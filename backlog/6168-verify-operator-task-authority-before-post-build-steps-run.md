---
bornAs: xqqmw6g
kind: story
size: 5
status: open
scaffoldedBy: "fix-5242"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/operations/operator-task-brief.mjs", "we:scripts/backlog/operator-task.mjs", "we:scripts/lib/operator-task-settings.mjs", "we:scripts/settings/operator-task.json", "we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/file-item.mjs", "we:scripts/operations/file-item-io.mjs", "we:scripts/operations/scaffold.mjs", "we:scripts/backlog/scaffold.mjs", "we:scripts/lib/build-queue.mjs", "we:scripts/backlog.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/conveyor/prepare-result.mjs", "we:scripts/lib/probation-launcher.mjs", "we:skills-src/conveyor/prepare-item-worker-brief.md", "we:docs/agent/backlog-workflow.md", "we:scripts/check-standards-rules.mjs", "we:scripts/operations/dispatch-lane.mjs", "we:scripts/lib/__tests__/build-queue.test.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/__tests__/operator-task.test.mjs", "we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs", "we:scripts/operations/__tests__/file-item.test.mjs", "we:scripts/operations/__tests__/file-item-io.test.mjs", "we:scripts/operations/__tests__/scaffold.test.mjs", "we:scripts/backlog/__tests__/scaffold.test.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# verify operator-task authority before post-build steps run

Split out of PR 5242 by the operator (send-back 2026-10-15 ~10:25 ET, items 1 and 2). PR 5242 ships only `--operatorTask` filing (complete-brief check, filing prepare stamp) and the report post-build step; edge-load and live-proof steps are off for every card. This card owns all the operator-authority work.

The authority work was built in PR 5242 and then removed from it (the removed code is at commit 58de31ca6, the PR 5242 head before the split; `git show 58de31ca6:<path>`, or the PR's commit list on GitHub, which keeps it after a squash merge):

- **The operator instruction record.** `operatorInstruction: {actor, channel, at, words}` written by file-item from `--operatorActor`, `--operatorChannel` and `--operatorWords`; `validateOperatorInstruction` (actor, lower-cased, must be an `OPERATOR_LOGINS` login; one-line bounded fields; ISO `at`); the standards gate refusing a malformed record, a record without `operatorTask: true`, and a `preparedBy` other than `"operator-filing"`.
- **hasOperatorRecord gating.** Every operator-task treatment (post-build steps, the filing prepare stamp, an explicit P0, the `operatorPostBuild` route flag) read `hasOperatorRecord(item)`, never the bare `operatorTask` flag. A bad record made the card ordinary at dispatch rather than failing the read (operator login lists can differ per process, `WE_OPERATOR_LOGINS`).
- **Queue changes.** An explicit card `priority: P0..P4` in we:scripts/lib/build-queue.mjs (`explicitCardPriority`): classes gated by `build.operatorTask.enabled` and a `maxPriority` cap, P0 needing an operator record, `now`/`high` claims under the same switch and cap, an admitted P0 preceding `build.priority` in every queue mode; an ignored claim named in the queue row's reasons (`card priority: P0 ignored (<why>)`); file-item `--priority` with the same checks at filing; the build-queue cache key over `build.operatorTask` and `WE_OPERATOR_LOGINS`.
- **dispatch-plan changes.** A filing stamp marked `preparedBy: "operator-filing"` counting only while operator tasks are enabled AND the card carries a valid record, else held `needs-prepare`; `projectBuildQueueRow` carrying `preparedBy`, `operatorTask`, `operatorInstruction`; the CLI passing `build.operatorTask` into the prepare policy.
- **Probation and prepare changes.** prepare-stamp removing `preparedBy`; `preparedBy` in `PREPARE_OWNED_FRONTMATTER_KEYS` so the probation tamper check allows that removal; prepareCardStatus reporting a filing stamp as unstamped; the prepare-item brief allowing the `preparedBy` edit.

## Design
Gate operator-task treatment on an operator-task status that is verified by a recorded operator instruction, not on card frontmatter the card author can write. The removed operatorInstruction record was self-asserted: anyone who can edit a card can write it. Decide what makes the record verifiable (for example a durable operator-authored marker, like clear-human, that the dispatcher reads from a source the card author cannot write), then rebuild the five pieces above on that verified status. Re-decide build.operatorTask.enabled and a maxPriority cap as part of the same gate.

## Done when
- planOperatorPostBuild emits edge-load and live-proof steps only for a card whose operator status is verified from a recorded operator instruction outside the card author's control.
- build.operatorTask.enabled and the postBuild leaves gate those steps as documented in we:docs/agent/backlog-workflow.md.
- The PR 5242 review finding on planOperatorPostBuild in we:scripts/operations/operator-task-brief.mjs (the steps depend on self-asserted operatorTask frontmatter) is resolved.
- renderOperatorEdgeStep and renderOperatorProofStep are wired back into planOperatorPostBuild, and the postBuild defaults in we:scripts/lib/operator-task-settings.mjs and we:scripts/settings/operator-task.json are revisited.
- file-item accepts --edgeClone and --liveProof-* again (operatorTaskFields in we:scripts/backlog/operator-task.mjs refuses them while the steps are off).
- An explicit card P0 (and any P0..P4 card priority, with its enabled switch and maxPriority cap) is honoured by the build queue only for a verified operator task, at filing and for a hand-edited card.
- The filing prepare stamp lets a card skip prepare only for a verified operator task; otherwise dispatch-plan holds it `needs-prepare`, and prepare recovery and the probation tamper check handle the stamp's replacement.
- The other treatments the bare `operatorTask` flag still grants in PR 5242 are gated the same way, or explicitly ruled safe by the operator: the report step, the operatorPostBuild route flag (which forces the agent route in we:scripts/operations/dispatch-lane-io.mjs) and the filing prepare stamp.

## Edge cases
- A card that copies a real operator record from another card.
- A record whose actor is a valid operator login but which no operator ever posted.
- Operator login lists that differ per process (WE_OPERATOR_LOGINS).
- Grouped builds, which already refuse operator post-build steps.
- A hand-edited `priority: P0` or `priority: now` on an ordinary card.
- An operator card filed while build.operatorTask.enabled=false, then enabled; and the reverse.

## Test plan
Unit tests in we:scripts/operations/__tests__/operator-task.test.mjs: a forged or copied record composes no edge-load or live-proof step, gets no P0 class and no prepare skip; a verified record composes them; enabled=false composes none. Build-queue and dispatch-plan tests for the P0 and filing-stamp rules.

## Proof plan
Dispatch a real operator card with a verified record and an edgeClone, and show the composed brief carries the edge step and the queue places it first; show a card with a hand-written record does neither.

## Acceptance

- [A1] **Executable** — the forged-record cases in we:scripts/operations/__tests__/operator-task.test.mjs (run with `npm run test:unit -- <that file>`) fail before this item lands and pass after.

## Non-goals

- [N1] Changing the report step or the complete-brief check that PR 5242 already ships.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — operator words, channel and liveProof command reach the brief: one-line bounded fields, no `{{...}}` brief tokens, function replacement on insert.
2. **Truncated reads** — the verified marker is read with a bounded, complete read; a failed read means unverified.
3. **Shared state files** — n/a: the marker is read, not written, by the dispatcher.
4. **Fail closed** — an unreadable or unknown marker means an ordinary card.
5. **Identity scoping** — the marker names the card it authorizes, so it cannot be copied to another card.
6. **State over time** — a card edited after the marker was posted is re-verified against the marker.
7. **Who wrote it** — the marker's author must be a registered operator login, checked from the source, not the card.
