---
bornAs: xhtyn7m
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/dispatch-routing-policy-source.mjs", "we:scripts/operations/probation-build-run.mjs", "we:scripts/operations/run.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/review-extra-seats.test.mjs", "we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs", "we:scripts/operations/__tests__/probation-build-run.test.mjs", "we:scripts/operations/__tests__/juror-flags.test.mjs", "we:scripts/operations/__tests__/run-policy-routing.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "5b5713c629ecebb34634088f97c8228943e99c9a"
tags: []
---

# Prevention — Exercise policy routing through production entry points

Preserve the prevention goal from chalbert/web-everything#3209: prove the `judge:*`, `review-seat:*`, and `review-recheck` policy families through their production callers, protect critical-work gating, and account for partial seat reservations.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3209@184dca91d077f4089aa8e2b842232e69c15f5d75

## Progress

Preparation research (2026-11-19; no implementation or test execution):

- Old premise: six prevention requests, with historical locations at lines 800, 601, 12, 208, and 481 and a root-level policy reference. Corrected evidence: the policy is `we:scripts/lib/dispatch-routing-policy.json:3-9`; judge routing is `we:scripts/operations/cli-adapter.mjs:825-836`; the CLI factory is `we:scripts/operations/run.mjs:884-892`, wired into the CLI at line 1047. The factory supplies both `model: null` and a default Claude provider; either counts as a pin under the adapter's undefined checks, preventing an unpinned CLI judge from following policy.
- Old scope named `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs`, which does not exist. Existing snapshot coverage is in `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs:273-278` and only removes all kinds. Retain that existing coverage as evidence; add the full trust matrix in the planned matching suite `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs`. The CLI forwarding/default tests live in `we:scripts/operations/__tests__/juror-flags.test.mjs:361-405`, not the stale-checkout suite `we:scripts/operations/__tests__/run.test.mjs:1-15`; retain the flag suite for default migration and add the production-chain regression in the planned matching suite `we:scripts/operations/__tests__/run-policy-routing.test.mjs`.
- The partial-grant defect remains: `we:scripts/operations/review-extra-seats.mjs:728-743` reserves by distinct model/effort pair, then removes a provider on a short grant without retaining or releasing its IDs. Existing full-grant coverage at `we:scripts/operations/__tests__/review-extra-seats.test.mjs:965-977` proves two models get two calls, but not a short grant. A release implementation already exists at `we:scripts/operations/review-extra-seats.mjs:1083-1093`.
- Snapshot trust at `we:scripts/lib/dispatch-routing-policy-source.mjs:12-18` checks kinds only, ignoring the task-opening rows in `we:scripts/lib/dispatch-routing-policy.json:60-75`. Corrected scope includes deterministic full-gate comparison, not an optional transport hash.
- Standalone parsing still resolves a gated route with literal `gateClosed: false` at `we:scripts/operations/probation-build-run.mjs:230`. The dispatcher already computes its verdict and supplies a worker at `we:scripts/lib/dispatch-contracts.mjs:1386-1411`. Remove the standalone policy-selection path; retain validated explicit worker inputs. This implements the original suggested boundary without adding a new gate policy.
- The real recheck route and tool-bearing refusal are at `we:scripts/operations/review-extra-seats.mjs:2192-2216`. Existing production functions can be driven with fake provider IO; no live model call is needed.
- Size changes **3 → 5**: five source files × roughly 15–30 changed lines, plus six test files × roughly 40–80 lines (approximately 315–630 changed lines). Evidence above identifies three behavioral defects, caller-default migration, and three entry-point families. Scope covers five source files and six test files. As a story this carries size, not estimatedLoc.

- Validation repair: the previous scope used only existing adjacent suites, omitting the required source-matching test names. Corrected scope adds planned `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs` for snapshot trust and `we:scripts/operations/__tests__/run-policy-routing.test.mjs` for the CLI production chain; keep `we:scripts/operations/__tests__/juror-flags.test.mjs` for its obsolete default assertion at lines 361–381. Evidence: the kinds-only snapshot assertion is at `we:scripts/lib/__tests__/dispatch-routing-policy.test.mjs:273-278`, while `we:scripts/operations/__tests__/run.test.mjs:1-15` covers stale-checkout refusal. Size remains **5**; the revised six-suite estimate above includes the additional dedicated CLI suite. These new suites are planned build work, not files claimed to exist during preparation.

## Design

Use the policy header in `we:scripts/lib/dispatch-routing-policy.json:3-9` as the family checklist, without changing policy values or adding providers.

1. In `we:scripts/operations/run.mjs`, forward only actual model/provider choices. An absent flag and absent JUDGE_PROVIDER leave those options undefined; preserve CLI-over-environment precedence and cwd forwarding. Keep the adapter's inherited Claude fallback and explicit pin semantics. Tests must invoke `runOperationCli` → `createCliJudgeFactory` → `createDefaultJudge`, injecting at `resolveProvider`, not injecting `provider` (which itself pins the route).
2. Exercise `runExtraSeats` for `review-seat:<lens>` and `createRedTeamIo().runRecheck` for `review-recheck` in `we:scripts/operations/review-extra-seats.mjs`. Assert resolved provider/model/effort at the provider boundary, not just resolver return values. Retain the refusal of non-Claude repo-reading rechecks.
3. On a partial reservation in `we:scripts/operations/review-extra-seats.mjs`, release every returned ID before excluding that provider and replanning. Reuse `releaseCalls`; do not manufacture calls for uncovered model groups. A release error must stop admission with a visible failure reason and launch no further calls; retain the ledger charge rather than pretending cleanup succeeded. Track unused full grants across replanning/early exits so every grant is either consumed by a recorded call or released.
4. In `we:scripts/lib/dispatch-routing-policy-source.mjs`, accept a snapshot only when its full criticalWorkGate matches a valid disk gate structurally (including kinds, every openForNonCritical row, and metadata; object key ordering is immaterial). Reject missing, malformed, added, removed, or changed gate fields. Reject unverifiable disk evidence rather than trusting the environment. A valid disk policy remains the fallback; when neither source is trustworthy initialization refuses. This is a conservative trust check, not a new gate-opening rule.
5. In `we:scripts/operations/probation-build-run.mjs`, remove policy route synthesis for omitted --worker. Return no worker and use the existing no-worker refusal at `we:scripts/operations/probation-build-run.mjs:300`. Keep explicit roster IDs and dispatcher worker JSON validation, model allowlists, feature-roster constraints, and Gemini checker requirements. Do not reinterpret a bare explicit worker as proof that the critical-work gate was evaluated.

## MVP

Must deliver all five changes above and the acceptance matrix below in one bounded implementation. Update the old default-provider assertion explicitly, retaining separate inherited-Claude behavior coverage. No policy configuration changes, new authentication protocol for worker JSON, live-provider smoke, or blanket resolver rewrite.

Could later add an authenticated snapshot handoff and a repository-wide gated-call audit; neither substitutes for these regressions.

## Acceptance

The following names are required new or expanded regression tests. Each [A<n>] Executable line names a test selected by the queued commands in Test plan. Capture red/green evidence before claiming delivery; existing behavior-only coverage is strengthened with a failing regression or a wiring-removal mutation.

- [A1] Must: an unpinned CLI judge follows a nondefault `judge:<operation>` route; explicit CLI provider/model and JUDGE_PROVIDER still override policy, CLI wins over environment, and inherited configuration still yields Claude. Executable: `4828 CLI policy defaults and explicit pins` in `we:scripts/operations/__tests__/run-policy-routing.test.mjs`, with the default-forwarding assertion updated in `we:scripts/operations/__tests__/juror-flags.test.mjs`, plus `4828 direct judge policy default` in `we:scripts/operations/__tests__/cli-adapter.test.mjs`. The unpinned CLI assertion fails with today's null/model and Claude defaults.
- [A2] Must: added-seat and recheck families reach real production entry points with resolved provider/model/effort; a non-Claude repo-reading recheck refuses before spawn. Executable: `4828 policy family entry points` in `we:scripts/operations/__tests__/review-extra-seats.test.mjs`. Verify each family assertion fails when its production routing call is bypassed; retain positive inherited-route coverage.
- [A3] Must: a cap granting one of two model/effort calls leaks no unused reservation, never exceeds the grant, and releases unused grants on replanning/early exit. Release failure stops further launch with a visible reason. Executable: `4828 partial grants are accounted for` in `we:scripts/operations/__tests__/review-extra-seats.test.mjs`; today's short-grant branch fails the ledger assertion.
- [A4] Must: snapshot trust compares the entire gate, rejects unknown/incomplete evidence, and accepts equal gates independently of object key order. Executable: `4828 snapshot full gate trust matrix` in `we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs`; changed opening rows currently pass incorrectly. Include valid disk fallback and invalid-both initialization refusal.
- [A5] Must: standalone build/prepare parsing never invents a policy worker without gate evidence; explicit worker validation remains intact across doc-fix, bugfix, test-fix, prepare, and build-new-feature. Executable: `4828 standalone cannot bypass dispatch gate` in `we:scripts/operations/__tests__/probation-build-run.test.mjs`. Today's omitted-worker case selects policy and fails. Include scope inputs representing code, docs, configuration, and data: none supplies gate evidence merely by extension. Invalid worker/model input still refuses before worker execution.

## Test plan

Use hermetic policy fixtures derived from the current schema, isolate operator preferences/environment, reset module state between cases, and use fake provider IO. Do not replace the routing function under test. Freeze time/IDs for reservation assertions and check the persistent ledger as well as spy calls. In snapshot tables mutate each kind and each opening row independently, add/remove rows, change false to true, and cover missing gate, nonboolean row, invalid JSON and unreadable disk evidence. Test both the helper and initialization boundary.

Run only the affected files through the host queue. These commands strip repository locators for execution:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
adapter=we:scripts/operations/__tests__/cli-adapter.test.mjs
flags=we:scripts/operations/__tests__/juror-flags.test.mjs
seats=we:scripts/operations/__tests__/review-extra-seats.test.mjs
policy=we:scripts/lib/__tests__/dispatch-routing-policy-source.test.mjs
cli=we:scripts/operations/__tests__/run-policy-routing.test.mjs
runner=we:scripts/operations/__tests__/probation-build-run.test.mjs
node "${queue#we:}" run -- npx vitest run "${adapter#we:}" "${flags#we:}" "${cli#we:}"
node "${queue#we:}" run -- npx vitest run "${seats#we:}"
node "${queue#we:}" run -- npx vitest run "${policy#we:}" "${runner#we:}"
```

## Proof plan

Before implementation, add the named regressions and record failing assertions for A1, A3, A4, and A5 against unchanged production code. For already-working A2 routing and the direct-judge case, temporarily bypass each production route in an isolated working diff and record that the corresponding test fails, then restore it. Record command, assertion, and exit status for each red/green pair; missing-test success is not evidence. After implementation run the six affected suites through the queue and the runner-owned standards check. Confirm no provider processes or network calls occurred. Preparation itself records source observations only, not a claim that these tests have run.

## Follow-ups

Authenticated parent-to-child gate provenance and a broader static audit of gated resolver callers are outside this MVP. The full-gate check deliberately rejects unverifiable snapshots; restoring a valid on-disk policy is the operator recovery path. Do not weaken that refusal to retain broken-disk startup availability without a separately reviewed provenance design.
