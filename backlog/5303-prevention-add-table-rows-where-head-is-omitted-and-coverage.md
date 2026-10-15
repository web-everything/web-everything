---
bornAs: xwc42kb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-merge-gate.mjs", "we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs", "we:scripts/lib/__tests__/merge-gate-ci.test.mjs", "we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs"]
dateOpened: "2026-10-07"
preparedDate: "2026-10-15"
preparedAgainstSha: "4e7914456dc4199144b7e050f86d27fa7d0f1186"
tags: []
---

# Prevention — fail closed on unverifiable ledger coverage and malformed holds

The approval of web-everything/web-everything#4328 left prevention work: cover omitted heads, missing coverage heads, and malformed holds in the ledger gate. Preserve that goal with the current review-exemption behavior.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4328@6471e698edcab06fd605a9e34c3b8c2d082f58ab

## Progress

- Rechecked the source on 2026-10-15; no preparation stamp changed. The gap remains: the truthiness-guarded comparison at `we:scripts/lib/pr-merge-gate.mjs:379-382` allows an otherwise clearing verdict with missing head/coverage to clear; the unchecked `.some` at `we:scripts/lib/pr-merge-gate.mjs:373` throws for string/object/number holds. Null holds currently become an empty array.
- Old premise: every ledger clearance requires a verdict coverage head; original review citations named lines 317/319/322, and the previous preparation cited comparison line 380. Corrected premise: the comparison is now `we:scripts/lib/pr-merge-gate.mjs:381`, and `we:scripts/lib/pr-merge-gate.mjs:377` intentionally permits a derived review exemption without a current verdict. `we:scripts/lib/pr-state.mjs:58-62` derives that exemption only from a matching full head SHA. Therefore the coverage invariant applies to verdict-backed clearance, with a separate preservation case for valid exemptions. This is preservation of existing behavior, not a new exemption policy.
- Old scope included the generic merge wrapper suite and left caller tests unnamed. Corrected touch set: the gate source, its ledger table suite, and explicit CI/shadow regression suites in scope. `we:scripts/__tests__/pr-merge-gate.test.mjs:8` tests other exports rather than the ledger decision; retain it as regression-only. Caller behavior is observed at `we:scripts/lib/merge-gate-ci.mjs:268-269` and `we:scripts/lib/drain-ledger-shadow.mjs:117-132`; neither caller needs a source edit.
- The earlier claim that missing coverage makes the shadow transient branch wholly unreachable was too broad. `we:scripts/lib/pr-merge-gate.mjs:376` returns existing holds before checking coverage, so held inputs can still reach `we:scripts/lib/drain-ledger-shadow.mjs:128-130`. Preserve that branch unchanged.
- Size remains 3: approximately 20 changed lines in `we:scripts/lib/pr-merge-gate.mjs:343-382`, 90 in `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs:10-74`, and 25 each in `we:scripts/lib/__tests__/merge-gate-ci.test.mjs` and `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs` (about 160 total). This is a story; no estimatedLoc field is added.

## Design

Use the existing defer result for unreadable evidence, following [we:docs/agent/platform-decisions.md#verdict-ledger-pr-state-store](../docs/agent/platform-decisions.md#verdict-ledger-pr-state-store), rule F4, and the public contract at `we:scripts/lib/pr-merge-gate.mjs:343-358`. Defer means clear false and defer true; the CI consumer maps it to fail-closed.

Before invoking array methods, validate derived holds. Undefined retains the existing empty-array default; null and all other non-array values return the existing ledger-unreadable defer result. Preserve unreadable flags and unreadable hold-code precedence, then ordinary hold and non-clearing results.

For an otherwise clearing result, extract the head from either a string or its sha property. Require a non-empty string head. For a verdict-backed clearance, also require a non-empty string coverage head; absent, empty or non-string values defer with a fixed ledger-head-unverifiable reason. Do not interpolate malformed values. Preserve exact string equality and the existing non-deferred mismatch hold. Do not introduce SHA-length validation or case normalization into this gate.

Preserve the existing exemption predicate (no current verdict and derived reviewExempt true). It still requires a usable head but does not require nonexistent verdict coverage. Derivation remains responsible for validating the exemption against the live head, as in `we:scripts/lib/pr-state.mjs:58-62`; this task does not change that trust boundary. Update the gate JSDoc to state these requirements and the exemption exception.

Labels authority must return before inspecting ledger evidence. Unknown authority remains the stricter both mode. Existing holds remain holds even when coverage is missing; this change prevents unverifiable clearance rather than reclassifying all held inputs.

## MVP

1. Guard holds shape and otherwise-clearing head evidence in `we:scripts/lib/pr-merge-gate.mjs`, including its JSDoc.
2. Extend the ledger table and add a deterministic input-grid invariant in `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs`.
3. Add CI fail-closed and shadow unreadable regressions in `we:scripts/lib/__tests__/merge-gate-ci.test.mjs` and `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs`, using existing fixture/injection seams. No caller production changes or authority rollout.

## Test plan

- In `we:scripts/lib/__tests__/pr-merge-gate-ledger.test.mjs`, test ledger and both with labels clear: omitted head, null, empty string, empty object, empty/non-string sha; missing current coverage, missing headSha, empty/non-string headSha. Otherwise-clearing verdict-backed inputs must defer. Include both inputs missing. These assertions expose the current truthiness fallthrough.
- Test holds as string, object, number and null: no throw and unreadable defer. Test undefined and empty-array holds with valid matching evidence still clear; an ordinary hold remains a non-deferred hold; ledger-unreadable still defers.
- Loop a deterministic grid of head and coverage shapes. For non-exempt ledger/both inputs, clear implies both extracted values are non-empty strings and exactly equal. Include valid equal strings as a positive witness so an always-hold implementation fails.
- Preserve labels behavior for both label outcomes, even with malformed ledger inputs. Preserve unknown-authority fallback, mismatch holds, and both-mode label holds.
- Add valid review-exemption rows without a current verdict, missing-head exemption rows, and a current-verdict row with reviewExempt true to prove the flag cannot bypass verdict coverage. Run existing derivation coverage in `we:scripts/lib/__tests__/pr-state-review-exempt.test.mjs` as regression evidence.
- In `we:scripts/lib/__tests__/merge-gate-ci.test.mjs`, inject otherwise-clearing ledger facts with unavailable head/coverage and assert the ledger gate status is fail-closed for both/ledger; labels-mode behavior remains unchanged.
- In `we:scripts/lib/__tests__/drain-ledger-shadow.test.mjs`, use an accepted verdict event with no live verdict head and assert unreadable status rather than agreement. Preserve valid-head agreement, review exemption, no-ledger-row hold, and existing transient-held behavior. Assert the input verdict is unchanged.

## Proof plan

At implementation time, add the focused capability rows first and run them against the unchanged gate to capture the missing-head false-clear and malformed-holds failure. Apply the source fix and rerun the same rows, then the full affected suites. Do not claim all preservation rows fail before the fix.

All test execution must use the host heavy-run queue, invoked via `we:scripts/readiness/heavy-admission.mjs` with run, then the command separator, then npx vitest run and the selected repository-relative test arguments. Run the four scoped test suites plus regression-only `we:scripts/__tests__/pr-merge-gate.test.mjs` and `we:scripts/lib/__tests__/pr-state-review-exempt.test.mjs`. Run npm run check:standards through the same queue. Record actual before/after output and any unrelated failures. The preparation runner owns preparation checks and stamps; this card edit does not claim implementation tests passed.

## Follow-ups

- A repository-wide rule requiring unknown-input rows for every gate predicate is separate work; it is not necessary to close these concrete gaps.
- Broader caller head-sourcing audits and validation of arbitrary malformed objects beyond these inputs remain separate. This task preserves the existing derived-exemption trust boundary and does not change promotion settings or exemption policy.

## Done when

The new capability rows fail against the old gate and pass with the fix; positive clearance, review exemptions, ordinary holds, labels authority and shadow transient behavior remain covered. CI and shadow consumers demonstrate the intended fail-closed/unreadable mapping, and queued affected tests and standards checks pass.
