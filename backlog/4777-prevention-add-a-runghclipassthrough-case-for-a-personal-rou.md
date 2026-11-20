---
bornAs: xbkyj9x
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/helpers/secret-absence.mjs", "we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "0d9387483288dde233db07dcb90375fc631a746f"
tags: []
---

# Prevention — Add a runGhCliPassthrough case for a personal-route rate-limit 403 that asserts no fallback and the rat… (from chalbert/web-everything#3341 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:2418` — Add a runGhCliPassthrough case for a personal-route rate-limit 403 that asserts no fallback and the rate-limit retry/backoff path. A lens that asks for each exclusion in a predicate to have one wired-through test would catch this class.
2. `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19` — A linter rule banning `.toContain()` on arrays of strings when checking for secrets, or requiring environment variables to be serialized to a string (e.g., `JSON.stringify`) before substring assertions.
3. `we:scripts/lib/gh-throttle.mjs:1551` — A strict coverage gate enforcing that all documented guarantees in docstrings map to an explicit, named integration test that exercises the runtime behavior.
4. `we:scripts/lib/gh-throttle.mjs:443` — A review standard or coverage tool that demands explicit test cases for edge-case behaviors highlighted in code comments (such as relying on empty array boolean resolution).

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3341@88de395bbed34e2e273ba9ce0c35230bb5a9c14d

## Progress

Preparation refresh: the old premise was a missing wired-through personal-route secondary-limit test and an exact-element secret assertion, with optional plain-GET coverage. Inspection confirms those gaps remain. The old and corrected committed touch sets are the same two files in `scope:`; the plain-GET case is now mandatory, removing the builder's optional coverage choice. General lint/coverage infrastructure remains follow-up work. Size stays **3**: approximately 5 changed lines in `we:scripts/lib/__tests__/helpers/secret-absence.mjs:16` and 80–110 test lines in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:344` for three cases and their assertions. This is a story; no `estimatedLoc` is added.

Source evidence and factual corrections:

- The public entry is now `we:scripts/lib/gh-throttle.mjs:2250`, delegating to the uncached implementation at `we:scripts/lib/gh-throttle.mjs:2284`. The old fallback citation at line 1773 is now `we:scripts/lib/gh-throttle.mjs:2418`; the predicate exclusion is at `we:scripts/lib/gh-throttle.mjs:1553`; the empty-method `every` is at `we:scripts/lib/gh-throttle.mjs:443`. Opening review references above now point to current code.
- Existing non-rate-limit fallback tests are at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:344`, the rate-limit predicate assertion at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:375`, and primary exhaustion at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:290`. None is the requested personal-route secondary-403 retry case. The secondary cases in `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs:385` and `we:scripts/lib/__tests__/gh-throttle.fidelity.test.mjs:400` exercise runGhSync capture, not this identity/fallback combination. A numeric commit-message search also matches unrelated PR numbers, so it is not delivery evidence.
- Routing now shares `resolveGhPersonalRoute` at `we:scripts/lib/gh-throttle.mjs:1584`. The environment switch is policy-gated at `we:scripts/lib/gh-throttle.mjs:1574`; the explicit `throttle.personalRoute: true` seam remains available. No default or production caller changes are needed. Existing off/default-policy, unknown-command, missing-token and blocked-App tests remain regression coverage at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:159`, `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:170`, `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:208`, `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:217` and `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:361`.
- The helper still checks exact array membership at `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19`. Its callers are in the scoped test file (including `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:387`, `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:426` and `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:540`); rerun that entire file after strengthening it.

This preparation uses source inspection, not a claim of executed runtime proof. The runner owns stamps and checks; existing preparation metadata is preserved.

## Design

Add three named tests to `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs` and strengthen the environment substring check in `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19`. No production runtime change is intended.

The secondary-403 test calls runGhCliPassthrough with an injected spawn, explicit personal routing and token, APP_ENV with cost capture disabled, a fresh uncontended lockRoot under the task temporary directory, maxAttempts 3, retryBaseMs 1 and retryCapMs 1, and an injected sleep spy. Do not enable a reserved slot: that path intentionally permits only one attempt (`we:scripts/lib/gh-throttle.mjs:2486`). Use pr list, avoiding finished-CI cache candidates. Return status 1 and `HTTP 403: You have exceeded a secondary rate limit` on every personal-token spawn; return success on an App spawn so an accidental fallback produces a clear test failure.

Assert all three spawns carry the personal token, sleep calls equal [[1], [1]], final status/stderr preserve the failure, the parsed sidecar contains retry_exhausted for the personal identity and no personal_token_rejected, and neither personal core nor graphql budget block exists. The exclusion at `we:scripts/lib/gh-throttle.mjs:1553` bypasses access-denial fallback; secondary classification at `we:scripts/lib/gh-throttle.mjs:1416` bypasses primary-budget handling; exhaustion and sleep are at `we:scripts/lib/gh-throttle.mjs:2487` and `we:scripts/lib/gh-throttle.mjs:2496`. The capped 1ms tuning makes exact sleep assertions independent of the retry factor.

Replace the helper's array assertion with a substring assertion over Object.values(process.env).join('\n'). Preserve its log, sink and environment-snapshot checks. The helper self-test inserts a unique sentinel inside a longer environment value and expects the helper to throw; restore the previous value (or delete the new key) in finally. Include a sentinel with a quote/backslash so serialization escaping cannot weaken the check. Update the helper comment if necessary. No lint rule is introduced.

The plain-GET test calls runGhCliPassthrough with ['api', 'repos/o/n'], explicit personal routing and a successful injected spawn; assert one spawn with the personal token. This wires the empty-method-list behavior through routing, beyond the existing classifier assertion at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:43`.

## MVP

1. Mandatory named secondary-403 retry/exhaustion test with the full identity, backoff, output, log and budget assertions above.
2. Environment substring fix and a named negative helper self-test in the same scoped test file.
3. Mandatory named plain-GET routing test. Retain existing default, caller-credential and fail-closed regression tests unchanged.

## Acceptance

Test names below are proposed names in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`. Every selected-test proof must reject zero matching tests; never use passWithNoTests. Preservation guarantees already work in production, so their before/after failure proof is a controlled regression mutation, not a claim that today's runtime is broken.

- [A1] Executable — `personal secondary 403 retries without App fallback`: run the queued targeted test. Before adding it, require named-test presence and fail when absent. With it added, remove only the rate-limit exclusion at `we:scripts/lib/gh-throttle.mjs:1553`: it must fail on the identity/attempt assertions. Restore the exclusion: it must pass with exactly three personal spawns, two 1ms sleeps, preserved failing status/stderr, retry_exhausted, no rejection log and no primary budget block. Independently changing the exhaustion bound or bypassing sleep must fail the same test; restore after each proof.
- [A2] Executable — `secret helper rejects embedded environment sentinel`: run the queued targeted test with the original helper, which must fail because no exception is thrown; apply the substring fix and require it to pass. Existing helper callers must pass in the full scoped-file run. This is the changed fail-closed behavior: an embedded secret can no longer be accepted as absent.
- [A3] Executable — `plain API GET routes to personal token`: require named-test presence (absent before build), then run it with the empty-method predicate at `we:scripts/lib/gh-throttle.mjs:443` temporarily requiring a nonempty methods array; it must fail. Restore the predicate and require one successful personal-token spawn. Production defaults and caller policy remain unchanged; the existing regression cases identified in Progress must also pass.

## Test plan

Implement the three named cases using existing imports and fixture conventions in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`. Run A2 against the old helper before applying the fix. Exercise A1/A3 with narrowly scoped temporary runtime mutations and restore each mutation before the next run. Mutation edits are proof-only and must not appear in the final diff. Do not weaken existing assertions to accommodate the stronger helper.

Use the host queue for every Vitest run. Set HEAVY to the repository-relative filesystem path corresponding to `we:scripts/readiness/heavy-admission.mjs` and TEST to that corresponding to `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs` (the `we:` prefix is citation syntax, not part of either shell value). The executable command is `node "$HEAVY" run --wait-ms=60000 -- npx vitest run "$TEST" --reporter=verbose`; append `-t` and the exact proposed test name for each targeted proof. Named-test presence is established from the verbose results as well as source inspection, not merely exit status.

## Proof plan

Capture A2's failure with the original helper, each controlled mutation's named failing assertion, and the restored scoped-file green run listing all three cases. Verify the final diff contains only the two implementation touch-set files when building; preparation itself edits only this card. No live GitHub calls are required.

The runner performs preparation checks and stamping. At build time, run the standards gate through `node "$HEAVY" run --wait-ms=60000 -- npm run check:standards`. If admission is busy, use that single bounded queue wait, then stop and report; do not poll or run tests outside admission. Keep scratch artifacts in the task temporary directory. Report observed results without claiming unexecuted proofs.

## Follow-ups

Outside this bounded implementation: a general lint rule for secret substring assertions; a review lens requiring a wired-through test for each predicate exclusion; a docstring-guarantee coverage mapping tool; and a review standard for comment-highlighted edge behaviors. These are the original review's broader prevention proposals, not prerequisites for the three concrete cases. No new policy choice, dependency-edge change, or production-default change is proposed here.
