---
bornAs: xbkyj9x
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/helpers/secret-absence.mjs", "we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs"]
dateOpened: "2026-10-01"
preparedDate: "2026-11-20"
preparedAgainstSha: "e1d5b705731cc71884a5bebad9444414e28fb332"
tags: []
---

# Prevention — Add a runGhCliPassthrough case for a personal-route rate-limit 403 that asserts no fallback and the rat… (from chalbert/web-everything#3341 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:2417` — Add a runGhCliPassthrough case for a personal-route rate-limit 403 that asserts no fallback and the rate-limit retry/backoff path. A lens that asks for each exclusion in a predicate to have one wired-through test would catch this class.
2. `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19` — A linter rule banning `.toContain()` on arrays of strings when checking for secrets, or requiring environment variables to be serialized to a string (e.g., `JSON.stringify`) before substring assertions.
3. `we:scripts/lib/gh-throttle.mjs:1544` — A strict coverage gate enforcing that all documented guarantees in docstrings map to an explicit, named integration test that exercises the runtime behavior.
4. `we:scripts/lib/gh-throttle.mjs:443` — A review standard or coverage tool that demands explicit test cases for edge-case behaviors highlighted in code comments (such as relying on empty array boolean resolution).

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3341@88de395bbed34e2e273ba9ce0c35230bb5a9c14d

## Progress

Preparation investigation (2026-11-20): the goal remains outstanding by source inspection, not by a commit-message search. The old premise cited a monolithic passthrough at line 1644 and fallback at line 1773, and allowed the plain-GET regression to be skipped. The corrected premise is that the public wrapper at `we:scripts/lib/gh-throttle.mjs:2250` delegates to the uncached implementation at `we:scripts/lib/gh-throttle.mjs:2284`; its personal-access fallback is at `we:scripts/lib/gh-throttle.mjs:2417`, and bounded rate-limit retry is at `we:scripts/lib/gh-throttle.mjs:2498`. The exclusion remains at `we:scripts/lib/gh-throttle.mjs:1553`, secondary-limit classification at `we:scripts/lib/gh-throttle.mjs:1416`, and empty-method classification at `we:scripts/lib/gh-throttle.mjs:443`.

The old and corrected touch sets are both the two frontmatter scope files. The corrected scope makes all three local regressions mandatory; broad lint/coverage machinery remains follow-up work. Existing predicate coverage at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:372` and access-denial fallback coverage at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:345` do not exercise a secondary-limit 403 through the passthrough. The primary-exhaustion case at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:290` exercises a different branch. The helper still has exact-element matching at `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19`.

Retain size 3: approximately 5 changed lines in `we:scripts/lib/__tests__/helpers/secret-absence.mjs:16` and 90–120 added lines beside the cases at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:345`, including isolation and assertions. This is a story, so no estimatedLoc is added. Search found the personal-route test file is the helper's only current importing test file. Existing stamps are left untouched for the runner. No runtime or test edits or mutation runs were performed during preparation.

## Design

Preserve production routing and defaults. Add regression coverage through public `runGhCliPassthrough`, using `['pr', 'list']` so the finished-CI cache wrapper does not introduce a proof call. The default personal-route-off case and the missing-token, write, access-denial and blocked-App cases already live in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`; retain them unchanged.

Add `personal secondary-limit 403 stays personal through bounded backoff` in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`. Use a fresh temporary lock root under the task TMPDIR, explicit personal-route opt-in, APP_ENV with cost headers disabled, maxAttempts 3, retryBaseMs 1, retryCapMs 1, an injected sleep spy, and a probeBudget spy. Return status 1 and `HTTP 403: You have exceeded a secondary rate limit` whenever the child credential is PERSONAL_TOKEN; return success for any other credential so an accidental App fallback is observable. Ensure ambient GH_DEBUG is absent and restored in finally. Assert three personal-token spawns, sleep calls exactly [[1], [1]], unchanged failure status/stdout/stderr, three personal-identity call records, one retry_exhausted record, no personal_token_rejected or budget_exhausted record, no budget probe, and no personal graphql or core budget block. The explicit retry cap avoids depending on deployment tuning. This exercises the terminal failure path without live GitHub access.

Change `we:scripts/lib/__tests__/helpers/secret-absence.mjs:19` to substring-check each environment value (iterate Object.values(process.env), asserting each string does not contain the sentinel). This avoids both array exact-match semantics and serialization escaping, without introducing cross-value matches. Keep the signature, sink/log checks and optional environment snapshot comparison unchanged. Add self-tests in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs` for embedded sentinel rejection, exact sentinel rejection, and clean values passing. Use no envBefore in the embedded-value test: otherwise snapshot inequality could falsely prove the substring guard. Restore the unique test environment key in finally, deleting it if originally absent.

Add `plain gh api GET without method routes to personal` through the public passthrough in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`: a successful injected child for `['api', 'repos/o/n']`, one spawn, personal credential, unchanged result. The existing classifier-only check at `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs:43` is retained but is not a substitute.

## MVP

1. Implement the helper substring correction and its positive/negative self-tests.
2. Add the bounded secondary-limit passthrough case with every assertion above.
3. Add the plain-GET passthrough case. It is mandatory, not builder-discretionary.

No runtime changes, new settings, changed routing defaults, production caller migration, general linter, or coverage framework are required. The helper's current caller is covered by the same scoped test run. Existing blocked-App tests remain the fail-closed regression coverage; this work adds no new admission policy.

## Acceptance

The named tests below are required additions in `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs`. For preservation guarantees, the before-build failure is missing named coverage, not a claimed production defect: check exact test-name presence before running Vitest (Vitest name filtering alone can silently select zero tests). After adding coverage, demonstrate the stated mutation failure as well as restored success.

- [A1] Executable — named test `personal secondary-limit 403 stays personal through bounded backoff`, run with the scoped command in Proof plan, proves no fallback, exactly three personal attempts and two 1ms sleeps, unchanged failure output, terminal logging, no probe and no primary-budget block. Its name-presence check fails before build; deleting only the rate-limit exclusion at `we:scripts/lib/gh-throttle.mjs:1553` must make the new test fail, and restoration must pass.
- [A2] Executable — named test `secret absence rejects embedded environment sentinel` fails against the old helper and passes after correction; companion tests `secret absence rejects exact environment sentinel` and `secret absence accepts clean environment` verify the guard rejects both leak forms and accepts clean values. Run all three with the scoped command in Proof plan. Require their names before execution; preserve all existing helper-caller assertions.
- [A3] Executable — named test `plain gh api GET without method routes to personal`, run with the scoped command in Proof plan, proves the empty-method route reaches the personal child once and preserves success. Its name-presence check fails before build; temporarily requiring methods.length > 0 at `we:scripts/lib/gh-throttle.mjs:443` must fail this test, and restoration must pass.

## Test plan

Use injected spawn, sleep and probeBudget only; never invoke real GitHub. Allocate independent temporary roots and clean them up, restore modified environment keys in finally, and avoid ambient credentials or debug settings affecting expectations. Keep existing default-off, missing-token, write-route, non-rate-limit fallback and blocked-App tests in the scoped run. No claim of new production behavior is made for A1/A3: these are preservation tests with mutation evidence.

First add the named tests and run the scoped suite against the old helper: A2 must fail for the embedded value. Fix the helper and obtain green. Mutate the exclusion for A1, run the named test and capture red; restore immediately. Separately mutate the empty-method condition for A3, capture red and restore. Never combine mutations or commit runtime changes. Finally run the full scoped file to detect interference with existing callers and defaults.

## Proof plan

Commands execute from WE; the visible references below carry repo prefixes. Strip the `we:` locus using shell variables so the commands remain executable:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
tests=we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs
node "${queue#we:}" run --wait-ms=60000 -- npx vitest run "${tests#we:}"
```

Before the build, use `rg -n -F` with each Acceptance test name against `we:scripts/lib/__tests__/gh-throttle.personal-route.test.mjs` (strip the locus as above); require a match for each. Record absent coverage as red. During mutation proofs append `-t` and the exact A1 or A3 name to the queued command. Record the failed assertion, not merely exit status. After restoring runtime source, verify the diff contains only the two scope files and rerun the scoped suite. Run standards through the same queue:

```sh
queue=we:scripts/readiness/heavy-admission.mjs
node "${queue#we:}" run --wait-ms=60000 -- npm run check:standards
```

If admission remains busy after that single bounded wait, stop and report deferred verification; do not poll. These are builder proof steps; the preparation runner owns preparation checks and stamping.

## Follow-ups

- General secret-assertion lint: detect exact-element assertions masquerading as substring leak checks, with positive and negative lint fixtures. This card fixes only the concrete helper instance.
- Predicate-exclusion review lens: require a named wired-through test per exclusion, starting from `we:scripts/lib/gh-throttle.mjs:1553`.
- Docstring guarantee coverage mapping: design an explicit mapping and stale/missing-mapping failures before imposing a strict gate; the motivating contract is at `we:scripts/lib/gh-throttle.mjs:1544`.
- Comment-edge review standard: generalize the empty-array regression at `we:scripts/lib/gh-throttle.mjs:443` without introducing a new gate in this change.
