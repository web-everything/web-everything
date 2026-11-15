---
bornAs: xav2mh1
kind: task
status: active
scaffoldedBy: "review-verdict-gate-deadlock-lane-31-ecc1228f"
dateScaffolded: "2026-11-15"
dateOpened: "2026-11-15"
tags: []
---

# Reinforce review publish gate: tell infra review-gate failure from a review hold

The accept publish requires each failed review-gate or merge-gate row to carry its own nonempty human-hold annotation (PR for #6769). The review-gate producer emits structured hold evidence on both its CLI and workflow fast paths; the reader binds that evidence to the latest completed job and reviewed head, refusing infrastructure-only failures. Strict publication now requires a complete merge-gate inventory before annotating a hold or converting a candidacy failure to success. Both loaded review-gate and merge-gate annotations are discarded before fresh proof at this boundary; early dispatch retains its existing classification policy.

## Acceptance

- [A1] Preserve dispatch through verdict publication with red review holds, without a CI rerun; a real red `test` must still hold. Defended by `dispatches after load and requires head-bound publication proof for $kind changes ($proof, test red: $testRed)` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`: valid proof permits one label write, and a real red test prevents dispatch and publication. Run the publication regression command below.
- [A2] Refuse infrastructure-only, unreadable, wrong-head or unproven review-gate failures. Defended by `does not reuse a loaded review-gate annotation when fresh proof fails: %s` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`: missing identity, unreadable jobs/logs, wrong head/run/check, infrastructure-only failures, empty/mixed holds and a throwing producer all refuse publication with zero label writes and no surviving annotation. Existing annotation-shape cases and producer/job-evidence wiring in `we:scripts/lib/__tests__/review-gate-hold.test.mjs` also defend plain failures. After-verification is owed by the launcher.
- [A3] Refuse incomplete, truncated or malformed merge-gate verdict evidence at publication, including tables omitting a non-human blocker. Defended by `requires complete merge-gate evidence through publication: %s` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`, which exercises the parser, fresh CI reader and publication sink, asserting refusal and zero label writes for invalid proof. The exact reported table, incomplete candidacy conversion, and each omitted non-human row reproduced red (25 failures); launcher verification supplies after-evidence. `does not reuse a loaded merge-gate annotation with %s on publication` also pins malformed and stale loaded proof. Run the publication regression command below.
- [A4] Must handle code, documentation, configuration and data PRs with the same head-bound proof requirements. Defended by `dispatches after load and requires head-bound publication proof for $kind changes ($proof, test red: $testRed)` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`: each kind dispatches, then permits publication only with fresh valid proof; wrong-head review evidence and incomplete merge evidence refuse with zero label writes.

Commands (run from the WE repository root):

```sh
npm run test:unit -- scripts/operations/__tests__/review-pr-io.test.mjs scripts/operations/__tests__/review-pr-io-early-publish.test.mjs
npm run test:unit -- scripts/lib/__tests__/merge-gate-hold-class.test.mjs
npm run test:unit -- scripts/lib/__tests__/review-gate-hold.test.mjs scripts/lib/__tests__/review-ci-gate-io.test.mjs scripts/__tests__/check-review-gate.test.mjs scripts/__tests__/ci-card-only.test.mjs
```

## Non-goals

- [N1] No CI rerun, merge-gate bypass at merge time, or automatic clearance of a human review label. This card strengthens the proof for verdict publication only.

## Risks

- Older review-gate runs without structured hold evidence remain held; the workflow reads its script from main, so producer rollout and live adoption require operator observation. No CI rerun is introduced.
- The shared dispatch classifier still accepts partial tables; strict publication validates the full current inventory before either excusal branch. Historical tables missing newer gates remain held until complete evidence is available. No CI rerun is introduced.
- Unexpected subprocess or forge writes can revive the earlier silent-rerun outage. The publish fixture allowlists the label-writer argv and gate/head reads, rejects other injected I/O, and records even swallowed attempts.

## Test plan

- A1: the dispatch/publication integration case above exercises the production planner, fresh dispatcher and publish sink with loaded same-head rows; its red-test variant asserts no child launch or label write. This is deterministic wiring proof; live daemon adoption and PR #6769 publication require separate operator observation.
- Annotation guards: `still holds when merge-gate annotation has %s` covers empty, non-array, null and missing holds, a null annotation, and mixed human/non-human lists in both orders. These pin the nonempty guard and universal allowlist predicate.
- A2: missing, empty, malformed and mixed review-gate annotations refuse publication. The producer suite runs both actual producers, binds evidence to job/run/check/head/repository, and rejects setup/cleanup failures, superseded jobs, truncated logs and unreadable or oversized output. A3 covers missing inventory rows, duplicates, unknown gates/statuses, malformed arrays, missing footer, non-human holds, fail-closed statuses, loaded annotations, and complete LF/CRLF evidence. No new after-run is claimed here before launcher verification.
- A4: the dispatch/publication matrix supplies code, documentation, configuration and data paths to the production planner, then exercises both invalid A2/A3 proof and valid proof at publication. Run the commands in Acceptance plus `npm run check:standards` before completing this card.
- Targeted mutations requested by review: dropping `holds.length > 0` must fail the empty case; replacing `every` with `some` must fail both mixed-list cases. Do these only in the sanctioned isolated mutation/revert harness; never weaken a live guard by hand.

## Prevention work recorded from PR #6874

- Add a `check:standards` rule rejecting active backlog cards whose Acceptance contains the scaffold's executable-command TODO. Target `we:scripts/check-backlog-item.mjs` and its tests; include an active-placeholder rejection and a completed-command acceptance. This broader checker change remains follow-up work outside this repair's three-file scope.
- Add a review-lens requirement for a mixed-input test whenever an `every`/`some` predicate guards a trust allowlist. The annotation table above supplies that coverage for this publish exemption.
- Add a deterministic `check:standards` rule in `we:scripts/check-backlog-item.mjs` and its tests: every active `[A#]` acceptance bullet must include `Defended by`, a repository-qualified test file, an existing test title and an observable assertion. Planned tests do not defend active guarantees; test missing, nonexistent and planned references as refusals, and a resolving reference as acceptance. This broader checker remains follow-up work outside this repair's scope. A1–A4 now name their publication regressions.
- Publication must strip both proof-bearing annotation fields before invoking either producer; the loaded-review-gate regression matrix pins failed revalidation and the existing loaded-merge-gate matrix pins its sibling. Consider a deterministic check that annotations consumed by `onlyVerdictDependentPending` have a matching strip at the fresh CI boundary.

## Edge cases this change must handle

1. **Untrusted text** — Parse structured gate evidence; never execute or trust commands embedded in logs or PR prose.
2. **Truncated reads** — Missing verdict rows or incomplete job output must retain the hold (A3).
3. **Shared state files** — No new shared-state writer; reuse the current run store and label publisher.
4. **Fail closed** — Missing, empty, mixed, malformed or unreadable hold proof must reject publication before writes (A2/A3).
5. **Identity scoping** — Bind proof to repository, PR, job and reviewed head; wrong-head evidence cannot authorize publication.
6. **State over time** — Re-read the head at publication; evidence from an earlier head cannot survive a push.
7. **Who wrote it** — Use trusted gate/job evidence, not unverified PR annotations or quoted verdict text.
8. **Receive/write endpoint controls** — n/a: no new HTTP endpoint, reset trigger or independent write API; existing publisher bounds and authorization remain responsible for writes.
