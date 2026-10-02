---
bornAs: xkecc48
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "91d9b89ae899dd70bd0cc1f410917670f5e9ad98"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3069's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. When a heal has a non-empty declared scope that names no WE path, log instead of silently treating it as unscoped. The filtering and permissive fallback currently live in `we:scripts/lib/probation-launcher.mjs:325-350`; emit the diagnostic from `we:scripts/operations/probation-heal-run.mjs` using its existing contextual logger. Preserve the current path-gate decisions and explicitly empty-scope behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3069@c6242481e154f15781db807ca3526b74ba6c4981

## Progress

- Original premise/scope: the review cited `we:scripts/lib/probation-launcher.mjs:335` and scoped only that helper module and `we:scripts/lib/__tests__/probation-launcher.test.mjs`; it suggested logging/escalation or a blanket non-empty-dispatch assertion.
- Corrected premise: the defect still exists, but the current filtering is in `we:scripts/lib/probation-launcher.mjs:325-329` and the empty-filtered-scope fallback is in `we:scripts/lib/probation-launcher.mjs:346-351`. The helper is pure; actual logging belongs in the runner. A blanket requirement that all heals have non-empty scope would change the explicitly supported empty-scope behavior and is unnecessary for this prevention guard.
- Source evidence: `we:scripts/lib/__tests__/probation-launcher.test.mjs:208-214` explicitly accepts both empty and foreign-only scopes. A direct Node import probe returned the identical `{ ok: true, reason: 'every path is allowed' }` for a foreign-only scope and an empty scope, while a mixed scope rejected a path outside its WE entry. This is not already delivered.
- Corrected scope: retain the helper and its tests, and add `we:scripts/operations/probation-heal-run.mjs` plus existing matching tests in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. The runner defines its contextual logger at line 88 and calls the path gate at line 175. Its existing fake-I/O harness can observe the diagnostic without launching a worker or contacting GitHub.

## Design

Use the logging remedy explicitly allowed by the original review. Add an exported pure diagnostic helper in `we:scripts/lib/probation-launcher.mjs` that reuses `weScopeEntries` and returns a warning string only when the supplied scope is non-empty but has zero WE entries. Return no warning for omitted/empty scope, bare local entries, explicit WE entries, or mixed scopes containing a WE entry. Keep existing prefix interpretation and path enforcement unchanged.

In `we:scripts/operations/probation-heal-run.mjs`, invoke the diagnostic once after the contextual logger is initialized and before lane acquisition. Send a returned warning through that logger. The warning must say that the declared scope contains no WE paths and therefore supplies no WE path restriction, and include the declared entries so an operator can identify the mismatch. The existing logger supplies PR and worker context. Logging before acquisition also covers mechanical/no-worker branches; do not wait for a successful worker diff to make the mismatch visible.

This is an additive diagnostic, not a new rejection policy. Keep the pure path gate free of I/O, its return contract unchanged, and all statute-tier, dispatch-machinery, envelope, and mixed-scope checks intact.

## MVP

1. Add and document the pure diagnostic helper beside the scope normalization in `we:scripts/lib/probation-launcher.mjs`, with focused tests in `we:scripts/lib/__tests__/probation-launcher.test.mjs`.
2. Import and log the diagnostic once at the runner entry in `we:scripts/operations/probation-heal-run.mjs`.
3. Extend the fake-I/O tests in `we:scripts/operations/__tests__/probation-heal-run.test.mjs` to record logs and ordering. Keep this one delivery containing the diagnostic and its observable runner wiring.

## Done when

1. A foreign-only declared scope produces one actionable, PR/worker-contextual warning before lane acquisition, including when no model repair is needed.
2. Omitted/empty, local-only, and mixed scopes with a WE entry produce no scope-mismatch warning. Existing allow/reject behavior remains covered and unchanged.
3. The focused Vitest command over `we:scripts/lib/__tests__/probation-launcher.test.mjs` and `we:scripts/operations/__tests__/probation-heal-run.test.mjs` passes. The new runner-warning regression fails on the pre-change implementation because no warning is emitted.

## Test plan

- In `we:scripts/lib/__tests__/probation-launcher.test.mjs`, cover one and multiple foreign-only entries; assert a useful warning with the supplied entries. Cover omitted scope, an empty array, a bare local path, an explicit WE path, and mixed local/foreign entries; assert no warning. Retain the existing foreign-only acceptance and mixed-scope rejection assertions to prove logging does not change enforcement.
- In `we:scripts/operations/__tests__/probation-heal-run.test.mjs`, use the existing injected I/O harness to record logs and acquisition. Assert exactly one mismatch warning before acquisition for foreign-only scope, both for a worker repair and a mechanical/no-worker run. Assert the PR and worker identity appear, and existing outcomes remain unchanged.
- Add runner negative cases for empty and mixed scope; match the specific scope diagnostic rather than counting all logs. Retain existing forbidden-path, outside-scope, and successful in-scope regressions.
- Execute the two focused suites with `npx vitest run` from the WE root, supplying the two test paths above with their repository prefixes removed for shell execution. Run `npm run check:standards` as the delivery consistency check.

## Proof plan

First add the runner-warning regression and run it against the existing runner: capture its failure on the absent warning. After implementation, capture the focused suites passing and the fake-I/O trace showing the contextual warning before acquisition. Pair that trace with empty/mixed-scope negative cases and unchanged path-gate results. This proves executable runner wiring without creating a real heal, PR, commit, or push; it is not evidence of a live provider dispatch. Capture the standards-check result separately. Preparation has only performed the direct helper probe recorded above; these implementation checks remain owed by the builder.

## Follow-ups

No follow-up is required to deliver the review's logging remedy. Broader scope validation, additional repository-prefix aliases, mandatory non-empty scopes, or changing foreign-only scope into a refusal would be separate work requiring its own justification; none is necessary for this diagnostic guard.
