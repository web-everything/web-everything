---
bornAs: xpmuh71
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/queue-store.mjs", "we:scripts/conveyor/__tests__/queue-store.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "34db86ff64c380df58af4211008d5173589627b4"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3065's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/queue-store.mjs:340` — Add a test that injects a linkSync failure (EPERM) to cover the fallback. More generally, review new catch branches for a test that exercises each error code they handle.
2. `we:scripts/conveyor/queue-store.mjs:338` — Add a small injectable `link` function parameter to writeQueueFileIfAbsent so the fallback branches can be unit-tested. Lower-cost alternative: a review-lens item that every documented fallback branch needs a named test.
3. `we:scripts/conveyor/queue-store.mjs:344` — Add a deterministic filesystem-failure test that forces the fallback and injects canonical publication between its existence check and rename; require preservation of the winning canonical contents. Use a genuinely exclusive publication mechanism or fail without replacing the destination.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3065@b776ad8090a2533b96be21db9565e219897081af

## Progress

- Premise checked against the acquired checkout. Original scope was the publication helper and its existing test file; original review citations described an EPERM fallback and a check→rename race. The locations remain current: `we:scripts/conveyor/queue-store.mjs:333-348` defines the helper, with the link at line 338, EEXIST handling at line 341, three fallback codes at line 342, and the unsafe rename at line 344. No delivering change was found in the current implementation.
- Corrected premise: this is both missing error-path coverage and a live non-overwrite defect, affecting EPERM, ENOTSUP, and EXDEV, not just EPERM. Retain the two-file scope: `we:scripts/conveyor/queue-store.mjs` and its matching existing test `we:scripts/conveyor/__tests__/queue-store.test.mjs`. A review checklist alone cannot guard the data-loss behavior.
- Evidence: the existing tests at `we:scripts/conveyor/__tests__/queue-store.test.mjs:298-316` exercise a winner before publication and ordinary link success/EEXIST, but never force link failure. The prior preparation recorded a temporary-directory probe that evaluated the actual helper source with injected filesystem bindings: link threw EPERM; the existence probe captured absence then wrote a competing canonical file before returning false. Observed result: publication returned true, the winner was overwritten, and no temporary file remained. That historical probe is not a new verification run; this preparation confirms the still-present fallback by inspecting the source.
- Consumer inspection: `migrateLegacyQueue` calls the helper at `we:scripts/conveyor/queue-store.mjs:290`; the CLI calls migration at `we:scripts/conveyor/queue.mjs:196`. Neither catches publication errors. Preserve that propagation and the existing two-argument call form; no CLI edit is required. The scope names implementation changes and matching tests, while this consumer remains read-only context.
- Re-preparation correction: the earlier CLI citation was line 159; the migration call now resides at `we:scripts/conveyor/queue.mjs:196-203`. The original two-file scope remains the corrected scope. Source inspection at `we:scripts/conveyor/queue-store.mjs:333-348` confirms that neither the injection seam nor the fail-closed publication behavior has landed. Existing migration cases at `we:scripts/conveyor/__tests__/queue-store.test.mjs:273-316` remain relevant. No stamp is changed by this preparation.
- Size 3 remains appropriate: one local dependency seam, removal of one unsafe fallback, and deterministic filesystem tests. Preparation does not implement the fix; independent review, checks, and stamping belong to the runner.

## Design

Use the review's explicitly permitted **fail without replacing the destination** behavior. Keep hard-link publication of fully written temporary contents as the sole success path. Remove the existence-check/rename fallback: an additional check cannot make rename exclusive, and direct exclusive creation followed by writing would expose partial canonical JSON to readers.

In `we:scripts/conveyor/queue-store.mjs`, extend the helper to `writeQueueFileIfAbsent(queue, path = resolveQueuePath(), { link = linkSync } = {})`. The optional dependency has the same synchronous source/destination arguments and error behavior as `linkSync`. Existing callers need no changes. Document this seam and the failure contract beside the helper before implementing it.

Return true only after successful linking; return false only for EEXIST. Rethrow the original error for EPERM, ENOTSUP, EXDEV, and other link failures, preserving its code and identity. After the temporary write succeeds, always attempt temporary-file cleanup through the existing finally block. Cleanup remains best-effort if unlink itself fails; do not promise removal under an unlink failure or expand this change to pre-publication write failures. Update its stale “already renamed away” comment. A filesystem without hard-link support will now fail migration visibly instead of risking canonical replacement; this is the failure outcome already authorized by the review, not a new portability policy. Queue contents and serialization require no migration.

## MVP

1. **Must 1 — injectable publication:** add the optional link dependency and document true/false/throw semantics in `we:scripts/conveyor/queue-store.mjs`, preserving production defaults and existing calls.
2. **Must 2 — preserve canonical ownership:** remove fallback publication for every non-EEXIST link error; preserve the original error and temporary cleanup.
3. **Must 3 — executable prevention:** extend `we:scripts/conveyor/__tests__/queue-store.test.mjs` with deterministic fault injection, winner preservation, error propagation, and cleanup assertions.

Land these together as one implementation-and-test change. Do not expand this into a general filesystem abstraction or a repository-wide catch-branch audit.

## Test plan

Extend `we:scripts/conveyor/__tests__/queue-store.test.mjs` using real temporary directories and the injected link operation; no permissions changes, sleeps, or host-specific filesystem assumptions.

- Keep the existing real-link success/EEXIST test: true on first publication, false on the second, exact first-writer bytes retained, no temporary files.
- Parameterize EPERM, ENOTSUP, and EXDEV with an absent destination. Inject a specific error object; require the same object to escape, the canonical path to remain absent, and no temporary files. Name this group “writeQueueFileIfAbsent rejects unsupported link publication”. These assertions detect today's fallback, which instead publishes successfully.
- Parameterize those same codes with a competing canonical file written inside the injected link operation immediately before throwing. Require exact winner bytes, the same thrown error, and no temporary files. This guards winner preservation at the publication boundary after removing the check→rename window.
- Inject EEXIST after creating a winner: require false, exact winning bytes, and cleanup. Inject an unrelated error such as EIO: require unchanged error identity, no destination, and cleanup.
- Add “publication dependency observes complete bytes and preserves default callers”: first exercise real-link publication with the existing two-argument form, then use the injected link to read the complete serialized temporary file before delegating to real linkSync; assert identical canonical bytes and cleanup. The injected callback must be observed, so this test fails against the current helper that ignores the third argument.
- Add “publication fault follows migration caller without reporting success”: use a test-local node:fs module mock and a fresh module import to force real production-default linkSync to throw EPERM during migrateLegacyQueue; assert the same error escapes, no canonical file appears, legacy bytes remain unchanged, and temporary cleanup occurs. Reset the mock/module cache in finally so existing tests retain real filesystem behavior. This tests the existing caller without adding a production migration seam.
- Preserve the existing migration test that publishes a winner via `hooks.beforePublish`, plus normal migration, dry-run, and legacy-file preservation tests. Do not replace those integration assertions with mocked filesystem behavior.

## Proof plan

The preparation probe above establishes the current race, not a passing implementation. During the build, use the host heavy-run queue entry point `we:scripts/readiness/heavy-admission.mjs` with `run -- npx vitest run` targeting `we:scripts/conveyor/__tests__/queue-store.test.mjs` (translate the repository-prefixed reference to its checkout-relative argument).

First add only the dependency seam and new tests while retaining the fallback: the unsupported-link/absent-destination cases must fail. Then remove the fallback and run the full matching test file; all cases must pass. Record the red and green outcomes and named tests. As a mutation check, restore the old fallback while retaining the seam: the regression cases must fail again; restore the fix afterward. This proves the tests detect unsafe fallback publication rather than merely exercising the injected function.

Run `npm run check:standards` through that same host heavy-run queue for the implementation change. If admission is busy, wait once using its supported wait option, then stop and report; do not poll. Review the final diff to confirm no overwrite primitive remains in this helper and that the ordinary overwrite helper is unchanged. Independent review should inspect error outcomes, winner bytes, complete-content publication, and cleanup; runner-owned preparation checks and stamping remain separate.

## Acceptance

Each executable below names a test to add in `we:scripts/conveyor/__tests__/queue-store.test.mjs`. Run the matching file through the queued command in Proof plan. Each named test must fail against the pre-build helper (which ignores the injection argument or publishes via fallback) and pass after the change. Existing passing migration tests are companion compatibility checks, not claimed red tests.

- [A1] Executable: “publication dependency observes complete bytes and preserves default callers” proves the optional seam is called with fully serialized contents, the production default remains real synchronous linking, existing two-argument callers work, and successful publication cleans up its temporary file.
- [A2] Executable: “writeQueueFileIfAbsent rejects unsupported link publication” parameterizes EPERM, ENOTSUP, and EXDEV; each preserves the original error object, leaves an absent destination absent, and removes the temporary file when unlink succeeds. This is the changed default on unsupported filesystems: visible failure, no rename fallback.
- [A3] Executable: “publication faults preserve the competing winner” parameterizes EPERM, ENOTSUP, and EXDEV; write the competing canonical bytes in the injected link before throwing, then require unchanged winner bytes, original error identity, and cleanup.
- [A4] Executable: “injected EEXIST preserves the winner and returns false” creates a winner in the injected link and throws EEXIST; require false, exact winner bytes, and cleanup. The current helper ignores this callback and returns true, making the test red before the seam exists.
- [A5] Executable: “unexpected publication error preserves identity and cleans up” injects EIO; require the same error, absent canonical destination, and cleanup. This covers the fail-closed unknown-error path without changing its existing production semantics.
- [A6] Executable: “publication fault follows migration caller without reporting success” forces EPERM through the default filesystem binding during migration and requires propagation, absent canonical state, unchanged legacy contents, and cleanup. The old fallback instead returns migration success. The CLI call at `we:scripts/conveyor/queue.mjs:196-203` remains unchanged and cannot reach its success emitter when migration throws.

The entire matching test file and queued standards gate must pass after implementation. Temporary cleanup guarantees above assume unlink succeeds; failures before the temporary write completes are outside this guard's scope.

## Follow-ups

No follow-up is required to complete this guard. The original suggestion to inspect every new catch branch is broader review practice, not a substitute for these tests and not part of this two-file change. Any future hard-link-free publication support must demonstrate both exclusive ownership and fully written contents before replacing the fail-without-publication behavior.
