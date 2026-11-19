---
bornAs: xkecc48
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/probation-launcher.mjs", "we:scripts/lib/__tests__/probation-launcher.test.mjs", "we:scripts/operations/probation-heal-run.mjs", "we:scripts/operations/__tests__/probation-heal-run.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "010edda66b69fef3cbd841dddb959dc04e155c10"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3069's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. When a heal has a non-empty declared scope that names no WE path, log instead of silently treating it as unscoped. The filtering and permissive fallback currently live in `we:scripts/lib/probation-launcher.mjs:395-422`; emit the diagnostic from `we:scripts/operations/probation-heal-run.mjs` using its existing contextual logger. Preserve the current path-gate decisions and explicitly empty-scope behavior.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3069@c6242481e154f15781db807ca3526b74ba6c4981

## Progress

- Original premise/scope: the previous preparation located filtering/fallback at `we:scripts/lib/probation-launcher.mjs:325-351`, cited tests at `we:scripts/lib/__tests__/probation-launcher.test.mjs:208-214`, and placed the contextual logger/path gate at lines 88/175 of `we:scripts/operations/probation-heal-run.mjs`. Its four-file scope already included both implementation files and their matching tests.
- Corrected premise: filtering now lives at `we:scripts/lib/probation-launcher.mjs:395-399`; the permissive fallback remains at `we:scripts/lib/probation-launcher.mjs:416-422`. Empty and foreign-only scopes remain explicitly supported by `we:scripts/lib/__tests__/probation-launcher.test.mjs:224-230`. The contextual logger is now in the internal heal arc at `we:scripts/operations/probation-heal-run.mjs:317-319`, acquisition at `we:scripts/operations/probation-heal-run.mjs:343`, and the path gate at `we:scripts/operations/probation-heal-run.mjs:415`. Inspection of this arc found no scope-mismatch warning; the logging remedy remains owed.
- Corrected scope: retain all four scoped files. The fake-I/O harness currently drops logs and does not record acquisition (`we:scripts/operations/__tests__/probation-heal-run.test.mjs:156-159`); new tests must instrument both, preferably with per-test overrides so existing call-order assertions remain intact. Mechanical coverage already exists at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:209-217`; path-refusal coverage exists at `we:scripts/operations/__tests__/probation-heal-run.test.mjs:339-357`.
- Defaults/callers: argument parsing supplies an empty array when scope is absent (`we:scripts/operations/probation-heal-run.mjs:285`). The runner forwards scope unchanged to acquisition, the worker task, and the path gate (`we:scripts/operations/probation-heal-run.mjs:343`, `we:scripts/operations/probation-heal-run.mjs:382`, `we:scripts/operations/probation-heal-run.mjs:415`). None of these defaults or callers needs a policy change.
- Size remains 3: approximately 20 helper lines, 5 runner lines, 35 helper-test lines, and 70 runner-test lines across the existing four-file touch set. This is a story, so no estimatedLoc field is added. Preparation inspected source and existing assertions; no new implementation or runtime test has been executed. The runner owns checks and stamping.

## Design

Use the logging remedy explicitly allowed by the original review. Add an exported pure diagnostic helper in `we:scripts/lib/probation-launcher.mjs` that reuses `weScopeEntries` and returns a warning string only when the supplied scope is non-empty but has zero WE entries. Return no warning for omitted/empty scope, bare local entries, explicit WE entries, or mixed scopes containing a WE entry. Keep existing prefix interpretation and path enforcement unchanged.

In `we:scripts/operations/probation-heal-run.mjs`, invoke the diagnostic once in the internal heal arc after the contextual logger is initialized and before lane acquisition. Send a returned warning through that logger. The warning must say that the declared scope contains no WE paths and therefore supplies no WE path restriction, and include the declared entries so an operator can identify the mismatch. Render entries as escaped data (for example JSON string encoding), ensuring control characters cannot create terminal escape sequences or forged log lines. The existing logger supplies PR and worker context. Logging before acquisition also covers mechanical/no-worker branches; do not wait for a successful worker diff to make the mismatch visible.

This is an additive diagnostic, not a new rejection policy. Keep the pure path gate free of I/O, its return contract unchanged, and all statute-tier, dispatch-machinery, envelope, and mixed-scope checks intact.

## MVP

1. Add and document the pure diagnostic helper beside the scope normalization in `we:scripts/lib/probation-launcher.mjs`, with focused tests in `we:scripts/lib/__tests__/probation-launcher.test.mjs`.
2. Import and log the diagnostic once at the runner entry in `we:scripts/operations/probation-heal-run.mjs`.
3. Extend the fake-I/O tests in `we:scripts/operations/__tests__/probation-heal-run.test.mjs` to record logs and ordering. Keep this one delivery containing the diagnostic and its observable runner wiring.

## Acceptance

- [A1] Executable: add `scope diagnostic distinguishes foreign-only from unrestricted and WE scopes` in `we:scripts/lib/__tests__/probation-launcher.test.mjs`. One/multiple foreign-only entries return an actionable warning naming the entries and absence of a WE path restriction; omitted/empty, bare-local, explicit-WE, and mixed scopes return no warning. Include control-character entries and require escaped output. This test fails before the helper exists and passes after implementation; retain the existing normalization semantics, including recognition of only the explicit `we:` prefix.
- [A2] Executable: add `foreign-only scope warns once before acquisition in worker and mechanical heals` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. Parameterize a worker repair and a green-gate mechanical rebase. Each must log exactly one scope warning with PR/worker identity and entries before acquisition, retaining its existing result and worker invocation behavior. Both cases fail on the current absent warning.
- [A3] Executable: add `scope warning leaves empty defaults and local or mixed callers quiet` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. Compare a foreign-only positive control with omitted, empty, bare-local, explicit-WE, and mixed scope cases; only the positive control warns. Assert scope is forwarded unchanged to acquisition. The positive control makes this regression fail before the build while covering unchanged defaults and callers.
- [A4] Executable: add `foreign-only warning preserves fail-closed path and envelope refusals` in `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. With foreign-only scope, require the warning and assert statute-tier, dispatch-machinery, and oversized diffs still refuse with no commit/push; ordinary allowed diffs still heal. Pair with the existing mixed-scope helper rejection and runner outside-scope rejection. The warning assertion fails before the build. This adds no new refusal policy: empty/foreign-only scopes continue to apply the existing safety gates.

## Test plan

- In `we:scripts/lib/__tests__/probation-launcher.test.mjs`, cover one and multiple foreign-only entries; assert a useful warning with the supplied entries. Cover omitted scope, an empty array, a bare local path, an explicit WE path, and mixed local/foreign entries; assert no warning. Retain the existing foreign-only acceptance and mixed-scope rejection assertions to prove logging does not change enforcement.
- In `we:scripts/operations/__tests__/probation-heal-run.test.mjs`, use the existing injected I/O harness to record logs and acquisition. Assert exactly one mismatch warning before acquisition for foreign-only scope, both for a worker repair and a mechanical/no-worker run. Assert the PR and worker identity appear, and existing outcomes remain unchanged.
- Add runner negative cases for empty and mixed scope; match the specific scope diagnostic rather than counting all logs. Retain existing forbidden-path, outside-scope, and successful in-scope regressions.
- Run A1–A4 and the existing regressions through the host heavy queue only: invoke Node on `we:scripts/readiness/heavy-admission.mjs` with arguments `run --wait-ms=60000 -- npx vitest run`, followed by `we:scripts/lib/__tests__/probation-launcher.test.mjs` and `we:scripts/operations/__tests__/probation-heal-run.test.mjs`. Strip repository prefixes when supplying these paths to the shell from the WE root. For consistency, use the same queue with `run --wait-ms=60000 -- npm run check:standards`. If admission remains busy after that one wait, stop and report; do not poll or run bare tests.

## Proof plan

First add the runner-warning regression and run it against the existing runner: capture its failure on the absent warning. After implementation, capture the focused suites passing and the fake-I/O trace showing the contextual warning before acquisition. Pair that trace with empty/mixed-scope negative cases and unchanged path-gate results. This proves executable runner wiring without creating a real heal, PR, commit, or push; it is not evidence of a live provider dispatch. Capture the standards-check result separately. The current preparation checked source and existing tests only; red/green implementation evidence remains owed by the builder. Run each new acceptance test against the pre-build implementation first, then the completed implementation; preserve the failure and passing outputs, including the positive controls in A3 and A4.

## Follow-ups

No follow-up is required to deliver the review's logging remedy. Broader scope validation, additional repository-prefix aliases, mandatory non-empty scopes, or changing foreign-only scope into a refusal would be separate work requiring its own justification; none is necessary for this diagnostic guard.
