---
bornAs: xhtyn7m
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/dispatch-routing-policy-source.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs", "we:scripts/operations/__tests__/juror-flags.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "638428de91d3b4e9fd3227fe9a50bd2d7349886c"
tags: []
---

# Prevention — Exercise policy routing through production callers and close gate/accounting gaps

Complete the prevention debt from chalbert/web-everything#3209: prove the `judge:*`, `review-seat:*`, and `review-recheck` families through production callers, preserve explicit pins, compare the complete critical-work gate, and prevent standalone routing and partial reservations from bypassing their guards. This includes bounded implementation fixes where the current production path contradicts the promised behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3209@184dca91d077f4089aa8e2b842232e69c15f5d75

## Progress

- Original premise/scope: five production files and five tests, size 3; a root-level policy file, a snapshot-source test file, and historical line references were assumed. Corrected premise: the policy is `we:scripts/lib/dispatch-routing-policy.json:2`; snapshot tests already live in `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs:273`. Retain that existing suite for integration coverage and add the planned matching source-module suite `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs` for focused gate comparisons. The family checklist is in the policy header at lines 8–9; read it without changing policy defaults.
- Judge evidence: `we:scripts/operations/cli-adapter.mjs:828` treats supplied factory model/provider values as pins. `we:scripts/operations/run.mjs:884` supplies `model: null` and default `providerName: 'claude'`, preventing an unpinned CLI call from reaching policy resolution. Add `we:scripts/operations/__tests__/juror-flags.test.mjs` to scope: its line 360 default-provider assertion must change while its line 380 explicit environment/flag precedence remains covered. The original line 481 citation is superseded by line 884.
- Reservation evidence: the original line 601 citation is superseded by `we:scripts/operations/review-extra-seats.mjs:728–741`. A short grant removes the provider without recording or releasing its granted IDs. `we:scripts/operations/__tests__/review-extra-seats.test.mjs:965` covers two models with two grants, not two models with one grant.
- Gate evidence: `we:scripts/lib/dispatch-routing-policy-source.mjs:12–18` compares only kind inclusion. Opening rules are at `we:scripts/lib/dispatch-routing-policy.json:63`. Existing broken-disk recovery is deliberately tested at `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs:222`; this item must not silently delete that recovery contract or claim an environment snapshot is authenticated.
- Standalone evidence: the original line 208 citation is superseded by `we:scripts/operations/probation-build-run.mjs:230`, which resolves an omitted worker using literal `gateClosed: false`. Its required-worker refusal already exists at line 300. The old behavior is asserted by `we:scripts/operations/__tests__/probation-build-run.test.mjs:630`; migrate that assertion to refusal, retain explicit-worker cases at line 639. Other inspected callers already supply a conservative gate: `we:scripts/operations/deliver-item-run.mjs:187` and `we:scripts/operations/dispatch-lane-io.mjs:2615`.
- Size 3 → 5: five production files × approximately 10–30 changed lines, plus six existing test files × approximately 25–65 lines (roughly 200–540 changed lines). The factory, short-grant branch, snapshot comparison, and runner default are separate behavioral seams, supported by the citations above. This remains a story; no estimatedLoc is added. Research was source inspection, not a runtime test verdict.

- Prepare-validation repair: the previous scope omitted the matching source-module test path. `we:scripts/lib/dispatch-routing-policy-source.mjs:12–18` owns the comparison, while `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs:222` owns child-import recovery. Add the planned focused suite `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs` for A3; retain the existing integration suite. Size remains 5: redistribute the gate matrix from the earlier six-suite estimate into this seventh suite (approximately 25–65 lines), without adding behavior or changing the production touch set.

## Design

1. Keep absence distinct from an explicit pin through `createCliJudgeFactory` into `createDefaultJudge`. Omit absent model/provider fields rather than supplying null/default values. Retain CLI-over-environment precedence, request-level pins, injected providers, model-only pins, tool restrictions, and the existing Claude fallback when policy inherits. Do not remove mandatory-lens/care/request-model safeguards to force routing.
2. Use actual callers: CLI parsing → factory → default judge for `judge:<operation>`; `runExtraSeats` for added-seat lenses; `createRedTeamIo().runRecheck` for `review-recheck`. Inject the final provider transport, quota reads and filesystem boundaries, not the resolver being proven. Fixtures use a valid nondefault policy so an ignored route is observable in provider/model/effort arguments. Cover base-family inheritance and specific-key precedence.
3. On a partial reservation, release every granted ID before removing that provider and replanning. This uses the existing release mechanism and preserves the current all-models-or-replan choice. A release failure must abort further launches and report the accounting failure; never report successful cleanup. Zero grants require no release. Full grants retain current execution behavior.
4. Compare the complete gate against a readable, valid disk policy: kind membership and every opening-rule key/value, independent of object ordering. Reject absent, malformed, added, removed or changed gate entries; route changes with an identical gate remain permissible. Keep the existing last-good recovery contract for syntactically broken disk policy, accepting only a structurally valid snapshot gate. This is consistency checking, not authentication. No parent/child hash protocol is introduced.
5. Remove standalone automatic route selection when `--worker` is absent. Let the existing required-worker refusal stop before acquisition or launch, with an operator-visible instruction to use the dispatcher or supply an explicit worker. Preserve validated worker IDs/JSON and their model restrictions. An explicit worker is an existing caller choice, not newly invented proof of dispatcher identity. Tests must cover all supported task types, including docs and preparation, rather than assuming only source-code builds need the guard.

## MVP

Implement the four bounded fixes and their production-entry regression tests in the declared scope. Put the focused snapshot comparison matrix in the planned source-module suite; retain child-import recovery in the existing policy integration suite. Update historical CLI/runner expectations explicitly. Keep policy values, provider roster, critical-work classification, persistent run schema, and dispatcher protocol unchanged. No paid model calls or external GitHub operations are needed.

## Acceptance

Each named regression below is to be added under a `4828 A<n>` test prefix. Run the new regression tests against the old implementation first, then against the fix; existing protective assertions remain green. Coverage-only family tests must also demonstrate failure when their production route lookup is bypassed, rather than claiming an already-working branch fails today.

- [A1] Executable — `4828 A1 unpinned CLI follows policy and explicit pins win` in `we:scripts/operations/__tests__/run.test.mjs`, with companion cases in `we:scripts/operations/__tests__/cli-adapter.test.mjs` and `we:scripts/operations/__tests__/juror-flags.test.mjs`: assert final provider/model/effort for no flags, explicit provider, explicit model, environment provider and CLI-over-environment. Verify inherited-policy Claude behavior and invalid/tool-bearing requests refuse before transport. The unpinned CLI case fails on the current factory defaults.
- [A2] Executable — `4828 A2 policy families reach production transports` and `4828 A2 partial grants are released before replanning` in `we:scripts/operations/__tests__/review-extra-seats.test.mjs`: drive lens-specific seats and production recheck, including the non-Claude repo-tool refusal; request two distinct models with one granted call and assert that ID is released exactly once before another launch. Cover zero/full grants, reserve failure and release failure (no subsequent launch). The short-grant case fails on the current dropped-ID branch; bypass each family lookup to demonstrate the routing assertions detect it.
- [A3] Executable — `4828 A3 complete gate comparison` in `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs`: table-drive every kind and opening-rule row, deleting entries, flipping booleans, adding an opening, and supplying malformed/missing gates. Reject mismatches on valid disk data; accept identical gates despite ordering and non-gate route edits. Preserve the existing broken-disk child-import test in `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs` and add a malformed-snapshot rejection case in that recovery path. Opening-rule mutations fail against the current comparison.
- [A4] Executable — `4828 A4 standalone requires a supplied worker` in `we:scripts/operations/__tests__/probation-build-run.test.mjs`: for every supported task type, omission refuses before acquisition, reservation or launch and reports the dispatcher/explicit-worker fallback. Explicit validated worker ID/JSON still works; invalid workers/models still refuse. The omitted-worker case fails against current automatic routing. Add a scoped caller assertion preventing literal open-gate routing from returning in this runner.

## Test plan

Use the host queue exclusively. For commands, bind a shell variable to each repo-qualified test reference above with its leading `we:` removed; call that variable `test_file`. Run `node "${queue_script#we:}" run -- npx vitest run "$test_file"`, where `queue_script=we:scripts/readiness/heavy-admission.mjs`. Run each of the seven scoped suites, including the complete existing pin/default and snapshot recovery cases, not only the new test prefix. Hermetic fixtures must isolate environment policy overrides, quota holds and scorecard/ledger state. Use task TMPDIR for filesystem fixtures and restore module/environment state after each case.

Pre-mortem: injecting a provider directly into the judge factory makes it a pin and would hide the routing defect; inject the resolver's final transport instead. A route-helper-only test misses the CLI default bug. A reservation-count-only assertion misses leaked IDs; inspect releases and launch ordering. A snapshot-only unit test misses module-load recovery; retain the real child-process import fixture.

## Proof plan

Record red/green output for A1, the partial-grant portion of A2, A3 and A4. For already-functional seat/recheck routing, record a controlled bypass mutation producing red, then restore it and record green. Record the seven scoped suites passing through the queue. No test execution is claimed by this preparation.

The runner owns preparation checks and stamps. The build's final standards command is `node "${queue_script#we:}" run -- npm run check:standards` with the same qualified queue-script binding. If admission is busy, use its bounded wait once, then report the limitation; do not poll. Report any unrelated baseline failure separately from regression results.

## Follow-ups

Authenticated parent-to-child snapshot provenance (including a gate hash and handling unavailable disk authority) is outside this consistency-test change; do not silently replace the existing last-good recovery policy. Broader repository-wide gated-caller enforcement can follow after this runner regression, without claiming this card audits every dynamic call site. No blocker changes are proposed.
