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

The accept publish requires each failed review-gate or merge-gate row to carry its own nonempty human-hold annotation (PR for #6769). The review-gate producer emits structured hold evidence on both its CLI and workflow fast paths; the reader binds that evidence to the latest completed job and reviewed head, refusing infrastructure-only failures. The merge-gate-hold-class incomplete-verdict residual remains follow-up work.

## Acceptance

- [A1] Preserve dispatch through verdict publication with red review holds, without a CI rerun; a real red `test` must still hold. Defended by `dispatches after load with red review holds and publishes without rerunning CI (test red: %s)` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`. Run the publication regression command below.
- [A2] Refuse infrastructure-only, unreadable, wrong-head or unproven review-gate failures. Defended by `still holds when a failed review-gate has %s` and `publishes when a failed review-gate proves only human-review hold ids` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`, plus producer/job-evidence and CI-reader wiring cases in `we:scripts/lib/__tests__/review-gate-hold.test.mjs`. The six initial negative cases reproduced the regression before the reader repair; after-verification is owed by the launcher.
- [A3] Must refuse incomplete, truncated or malformed merge-gate verdict tables, including tables omitting a non-human blocker. Add `does not annotate an incomplete verdict table that omits a blocking gate` to `we:scripts/lib/__tests__/merge-gate-hold-class.test.mjs`, red first, then green after enforcing completeness. Run the hold-classification regression command below.
- [A4] Must handle code, documentation, configuration and data PRs with the same head-bound proof requirements. Extend the A2/A3 fixtures across those file kinds; no file kind authorizes a weaker exemption.

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
- The current merge-gate classifier accepts incomplete verdict tables. A3 must require complete evidence rather than infer absent blockers are green.
- Unexpected subprocess or forge writes can revive the earlier silent-rerun outage. The publish fixture allowlists the label-writer argv and gate/head reads, rejects other injected I/O, and records even swallowed attempts.

## Test plan

- A1: the dispatch/publication integration case above exercises the production planner, fresh dispatcher and publish sink with loaded same-head rows; its red-test variant asserts no child launch or label write. This is deterministic wiring proof; live daemon adoption and PR #6769 publication require separate operator observation.
- Annotation guards: `still holds when merge-gate annotation has %s` covers empty, non-array, null and missing holds, a null annotation, and mixed human/non-human lists in both orders. These pin the nonempty guard and universal allowlist predicate.
- A2: missing, empty, malformed and mixed review-gate annotations refuse publication. The producer suite runs both actual producers, binds evidence to job/run/check/head/repository, and rejects setup/cleanup failures, superseded jobs, truncated logs and unreadable or oversized output. A3's incomplete merge-gate table tests remain future work. No new after-run is claimed here before launcher verification.
- A4: add the file-kind matrix to the same A2/A3 suites. Run the commands in Acceptance plus `npm run check:standards` before completing this card.
- Targeted mutations requested by review: dropping `holds.length > 0` must fail the empty case; replacing `every` with `some` must fail both mixed-list cases. Do these only in the sanctioned isolated mutation/revert harness; never weaken a live guard by hand.

## Prevention work recorded from PR #6874

- Add a `check:standards` rule rejecting active backlog cards whose Acceptance contains the scaffold's executable-command TODO. Target `we:scripts/check-backlog-item.mjs` and its tests; include an active-placeholder rejection and a completed-command acceptance. This broader checker change remains follow-up work outside this repair's three-file scope.
- Add a review-lens requirement for a mixed-input test whenever an `every`/`some` predicate guards a trust allowlist. The annotation table above supplies that coverage for this publish exemption.
- Require each acceptance guarantee to name its defending test. A1 maps dispatch, publication, no rerun and real-red refusal to the integration fixture; A2/A3 explicitly identify the outstanding residual tests.

## Edge cases this change must handle

1. **Untrusted text** — Parse structured gate evidence; never execute or trust commands embedded in logs or PR prose.
2. **Truncated reads** — Missing verdict rows or incomplete job output must retain the hold (A3).
3. **Shared state files** — No new shared-state writer; reuse the current run store and label publisher.
4. **Fail closed** — Missing, empty, mixed, malformed or unreadable hold proof must reject publication before writes (A2/A3).
5. **Identity scoping** — Bind proof to repository, PR, job and reviewed head; wrong-head evidence cannot authorize publication.
6. **State over time** — Re-read the head at publication; evidence from an earlier head cannot survive a push.
7. **Who wrote it** — Use trusted gate/job evidence, not unverified PR annotations or quoted verdict text.
8. **Receive/write endpoint controls** — n/a: no new HTTP endpoint, reset trigger or independent write API; existing publisher bounds and authorization remain responsible for writes.
