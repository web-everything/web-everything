---
kind: task
status: active
scaffoldedBy: "review-verdict-gate-deadlock-lane-31-ecc1228f"
dateScaffolded: "2026-11-15"
dateOpened: "2026-11-15"
tags: []
---

# Reinforce review publish gate: tell infra review-gate failure from a review hold

The accept publish now ignores a plain-failure review-gate and an annotated merge-gate hold (PR for #6769). Codex audit residuals: an infra failure of review-gate is indistinguishable from a review hold, and merge-gate-hold-class accepts incomplete verdict tables. Prove the hold from the verdict table or job evidence before exempting.

## Acceptance

- [A1] Preserve dispatch through verdict publication with red review holds, without a CI rerun; a real red `test` must still hold. Defended by `dispatches after load with red review holds and publishes without rerunning CI (test red: %s)` in `we:scripts/operations/__tests__/review-pr-io.test.mjs`. Run the publication regression command below.
- [A2] Must refuse infrastructure-only, unreadable, wrong-head or unproven review-gate failures. Before completing this follow-up, add `holds on review-gate infrastructure failure without same-head human-hold proof` to `we:scripts/operations/__tests__/review-pr-io.test.mjs`, and prove it red against the current exemption, then green with evidence validation. This criterion is still outstanding; plain `failure` alone is currently exempt.
- [A3] Must refuse incomplete, truncated or malformed merge-gate verdict tables, including tables omitting a non-human blocker. Add `does not annotate an incomplete verdict table that omits a blocking gate` to `we:scripts/lib/__tests__/merge-gate-hold-class.test.mjs`, red first, then green after enforcing completeness. Run the hold-classification regression command below.
- [A4] Must handle code, documentation, configuration and data PRs with the same head-bound proof requirements. Extend the A2/A3 fixtures across those file kinds; no file kind authorizes a weaker exemption.

Commands (run from the WE repository root):

```sh
npm run test:unit -- scripts/operations/__tests__/review-pr-io.test.mjs scripts/operations/__tests__/review-pr-io-early-publish.test.mjs
npm run test:unit -- scripts/lib/__tests__/merge-gate-hold-class.test.mjs
```

## Non-goals

- [N1] No CI rerun, merge-gate bypass at merge time, or automatic clearance of a human review label. This card strengthens the proof for verdict publication only.

## Risks

- An infrastructure failure currently looks like a review-gate human hold. A2 must distinguish them without recreating the verdict deadlock.
- The current merge-gate classifier accepts incomplete verdict tables. A3 must require complete evidence rather than infer absent blockers are green.
- Unexpected subprocess or forge writes can revive the earlier silent-rerun outage. The publish fixture allowlists the label-writer argv and gate/head reads, rejects other injected I/O, and records even swallowed attempts.

## Test plan

- A1: the dispatch/publication integration case above exercises the production planner, fresh dispatcher and publish sink with loaded same-head rows; its red-test variant asserts no child launch or label write. This is deterministic wiring proof; live daemon adoption and PR #6769 publication require separate operator observation.
- Annotation guards: `still holds when merge-gate annotation has %s` covers empty, non-array, null and missing holds, a null annotation, and mixed human/non-human lists in both orders. These pin the nonempty guard and universal allowlist predicate.
- A2/A3: the named tests above are required future work, not claimed as passing today. Missing proof must refuse before any label write; positive fixtures must still publish once.
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
