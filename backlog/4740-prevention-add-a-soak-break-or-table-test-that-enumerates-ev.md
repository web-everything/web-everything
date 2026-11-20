---
bornAs: x77fr13
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/missing-run-push.mjs", "we:scripts/conveyor/__tests__/missing-run-push.test.mjs", "we:scripts/conveyor/main-red-recovery.mjs", "we:scripts/conveyor/__tests__/main-red-recovery.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-19"
preparedAgainstSha: "2f581cdb099d32eadcb51cc41fba8819c7053bc0"
tags: []
---

# Prevention — Enumerate missing-run deferrals and reject structurally invalid recovery inputs

The approval review of chalbert/web-everything#3253 requested an exhaustive deferral regression guard, lane-only candidate selection, and counted failures for structurally invalid actuator inputs. This preparation retains those goals and accounts for subsequent recovery changes.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3253@95cb216548ba6b8e702c49527745ccd50355a7d6

## Progress

- Original premise/scope: the two-file actuator scope and citations to lines 29/31 implied all uncounted returns should represent transient state; candidate filtering was requested without its implementation or matching test in scope.
- Corrected premise: the structural-input guard still returns `defer` at `we:scripts/conveyor/missing-run-push.mjs:67-69`. Candidate selection at `we:scripts/conveyor/main-red-recovery.mjs:1311-1340` still accepts absent/non-lane branch names. Add that source and `we:scripts/conveyor/__tests__/main-red-recovery.test.mjs` to scope. The old line citations now refer to installation-token lookup, not the input guard.
- Partial delivery is not complete delivery: `we:scripts/conveyor/soak/breaks/missing-run-structural-deferral-loops.mjs:39-70` covers stacked/fork/ineligible-credential cases across ticks. Its recorded fix is ad1f47ac0; it does not enumerate the remaining deferrals or cover invalid branch inputs. Existing actuator tests at `we:scripts/conveyor/__tests__/missing-run-push.test.mjs:240`, `:342`, and `:395` already cover incomplete evidence, stacked/fork refusal, and credential refusal respectively.
- There are eleven current `return defer(...)` sites in `we:scripts/conveyor/missing-run-push.mjs`: lines 69, 74, 81, 84, 107, 122, 135, 163, 166, 168, and 184. They include explicit fail-closed evidence/admission refusals, not just provably transient states. Preserve those existing safety contracts rather than silently converting unreadable evidence into permission or asserting it necessarily clears with time. The shared admission contract is at `we:scripts/conveyor/recovery-preflight.mjs:12-77`.
- Caller evidence: the sweep's classic, startup-failure comparison, and final candidate populations all use the selector at `we:scripts/conveyor/ci-red-recovery-watch.mjs:1584-1610`. Its actuator result handling at `we:scripts/conveyor/ci-red-recovery-watch.mjs:1693-1706` skips markers only for `deferred`; ordinary failures already post counted markers. No caller implementation change or persisted-state migration is needed.
- Size remains 3. Estimated touch set: actuator guard about 10 changed lines, actuator table/inventory/sweep tests about 150, selector guard about 4, selector cases about 35 (roughly 199 changed lines in four files). Evidence for these bounded seams is the guard and selector cited above and the injectable fixture at `we:scripts/conveyor/__tests__/missing-run-push.test.mjs:17-43`. No new settings, cap defaults, storage format, or retry policy are introduced.

## Design

Use the requested table-test route. Validate descriptor structure before external IO: valid repository slug, positive safe-integer PR number, exact lowercase 40-hex SHA, and a string branch beginning with `lane/` with a nonempty suffix. Invalid structure returns the existing ordinary failure shape (`ok: false`, action, diagnostic, no `deferred: true`), allowing the existing caller to count it. Include an operator/ci-heal inspection hint; never push, dispatch, reserve, or read credentials for these inputs.

Apply the same branch predicate in `buildMissingRunCandidates` before rollup analysis. Missing, non-string, empty-suffix, and non-lane branches are excluded; valid lane branches retain existing required-context, partial-rollup, and startup-failure eligibility. Preserve the existing distinction between unknown and explicitly empty required-context sets.

In `we:scripts/conveyor/__tests__/missing-run-push.test.mjs`, maintain a table keyed by each deferral call site's diagnostic expression (distinguish repeated claim/head checks by occurrence). Compare the ordered extracted `return defer(...)` call sites in the source against the table so an added, deleted, or changed site requires an explicit fixture update. Then execute every row through the real actuator with injected IO: an inventory assertion alone is insufficient. After the input guard changes, ten sites remain.

Classify rows explicitly:

- Observable races/state that can change: initial and dispatch-time head/state mismatch; false/unknown mergeability; initial, dispatch-time, and push-time claim refusal; fetch-head mismatch; young queued CI run. For each, show a second invocation with corrected state advances beyond that guard; the young-run case advances by clock aging.
- Fail-closed evidence/admission refusals: explicit admission denied and incomplete run listing. Exercise missing/undefined admission inputs, exhausted/unreadable caps, malformed/oversized run evidence, and keep their current deferral behavior and inspection diagnostics. These are safety refusals, not a claim that time alone repairs evidence. No reservation, push, or dispatch may occur while refused.

The exhaustive table makes future structural deferrals visible for review; the invalid-input change closes the concrete remaining structural hole. Do not change all deferrals into attempts or introduce a new per-SHA deferral budget.

## MVP

Must deliver the descriptor guard, lane-only selector, exhaustive executable deferral inventory, and caller-counting regression in the four scoped files. Extend the existing injectable fixture only as needed to supply descriptor overrides and state transitions. Reuse the existing sweep and trusted marker/count helpers for a bounded repeated-tick test in the actuator test file.

Could extend the existing soak scenario later. That is not necessary to ship the requested table-test alternative.

## Acceptance

- [A1] Executable — In `we:scripts/conveyor/__tests__/missing-run-push.test.mjs`, add `invalid recovery descriptors are terminal counted failures before IO`: table-test malformed repo/SHA, missing descriptor, zero/negative/fractional PR number, and missing/non-string/non-lane/empty-suffix branch. Assert ordinary failure, a useful diagnostic, and zero external IO. Include a real-sweep harness with an injected trigger forwarding an invalid descriptor, durable trusted comments, and cap 2 over six ticks: exactly two counted failures, then `missing-run-cap-exhausted`, no mutation. The test fails before the guard change because valid-shaped non-lane input is deferred without a marker.
- [A2] Executable — In `we:scripts/conveyor/__tests__/main-red-recovery.test.mjs`, add `missing-run candidates require a nonempty lane branch`: cross branch inputs with known/unknown/empty required contexts and all-absent/partial/startup-only evidence. Invalid branches always yield no candidates; valid lanes preserve existing eligibility. This fails before the selector change because invalid branches enter the all-absent population. Exercise the real sweep with mixed valid/invalid listings in the actuator test file and assert invalid rows never reach trigger or per-candidate reads.
- [A3] Executable — In `we:scripts/conveyor/__tests__/missing-run-push.test.mjs`, add `every free deferral has an executable classified case`: compare source sites with the ten-row post-fix inventory and execute every row with the assertions in Design, including undefined admission inputs and run counts at/above 100. Fail closed with no push/POST/reservation on rejected evidence; changed state must advance transient fixtures. The inventory fails against the pre-build source because it still contains the structural-input deferral; restoring that return after the build must also fail A1. Existing legacy-call and explicit-preflight behavior remains covered rather than weakening either contract.

Run A1–A3 through the host queue: invoke `node` with entrypoint `we:scripts/readiness/heavy-admission.mjs`, arguments `run -- npx vitest run`, then test paths `we:scripts/conveyor/__tests__/missing-run-push.test.mjs` and `we:scripts/conveyor/__tests__/main-red-recovery.test.mjs`. The `we:` prefix denotes repository locus; strip it from filesystem arguments when executing from WE.

## Test plan

Add the failing A1–A3 tests before implementing the two guards, capture the expected failures, then implement and rerun those files through the host queue. All API calls, mutation attempts, claims, credentials, reservations, clock values, and comment persistence are injected; no live GitHub access. Scratch repositories use the task temporary directory.

Run caller regressions through the same queue in `we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs`, `we:scripts/conveyor/__tests__/missing-run-sweep-preflight.test.mjs`, `we:scripts/conveyor/__tests__/missing-run-startup-failure.test.mjs`, and `we:scripts/conveyor/__tests__/recovery-preflight.test.mjs`. If an old positive fixture omits the now-required branch, update it explicitly to a valid lane branch and add the missing-branch negative case; do not loosen the predicate. Expand scope to any such test file actually changed before delivery.

## Proof plan

Record queued red/green results and the source-site inventory. Demonstrate A1's two markers and cap-exhausted refusal after six ticks, A2's zero actuator calls for rejected candidates, and A3's zero mutations on every refused path. Restore the old structural `defer` and remove the selector predicate separately as temporary mutations: A1 and A2 must fail respectively; restore the implementation afterward. Add a temporary extra deferral to demonstrate the inventory refuses an unclassified site.

The runner owns preparation stamping and checks. During build verification, run `npm run check:standards` only through `we:scripts/readiness/heavy-admission.mjs`. No live soak or production mutation is required for this hermetic prevention change.

## Follow-ups

The existing soak scenario can later consume the table's structural cases to avoid divergent coverage. A global budget for persistent unreadable evidence or admission refusals would change retry policy and is outside this item; retain existing fail-closed behavior and operator diagnostics here. No blockedBy change is proposed.
