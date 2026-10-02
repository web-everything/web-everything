---
bornAs: xpmuh71
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/queue-store.mjs", "we:scripts/conveyor/__tests__/queue-store.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-02"
preparedAgainstSha: "f37a8934197efdf0a1f41d56d8e4af0b5c18d13d"
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
- Evidence: the existing tests at `we:scripts/conveyor/__tests__/queue-store.test.mjs:298-316` exercise a winner before publication and ordinary link success/EEXIST, but never force link failure. A temporary-directory probe evaluated the actual helper source with injected filesystem bindings: link threw EPERM; the existence probe captured absence then wrote a competing canonical file before returning false. Observed result: publication returned true, the winner was overwritten, and no temporary file remained. The probe changed no repository source.
- Consumer inspection: `migrateLegacyQueue` calls the helper at `we:scripts/conveyor/queue-store.mjs:290`; the CLI calls migration at `we:scripts/conveyor/queue.mjs:159`. Neither catches publication errors. Preserve that propagation and the existing two-argument call form; no CLI edit is required. The scope names implementation changes and matching tests, while this consumer remains read-only context.
- Size 3 remains appropriate: one local dependency seam, removal of one unsafe fallback, and deterministic filesystem tests. Preparation does not implement the fix; independent review, checks, and stamping belong to the runner.

## Design

Use the review's explicitly permitted **fail without replacing the destination** behavior. Keep hard-link publication of fully written temporary contents as the sole success path. Remove the existence-check/rename fallback: an additional check cannot make rename exclusive, and direct exclusive creation followed by writing would expose partial canonical JSON to readers.

In `we:scripts/conveyor/queue-store.mjs`, extend the helper to `writeQueueFileIfAbsent(queue, path = resolveQueuePath(), { link = linkSync } = {})`. The optional dependency has the same synchronous source/destination arguments and error behavior as `linkSync`. Existing callers need no changes. Document this seam and the failure contract beside the helper before implementing it.

Return true only after successful linking; return false only for EEXIST. Rethrow the original error for EPERM, ENOTSUP, EXDEV, and other link failures, preserving its code and identity. Always attempt temporary-file cleanup through the existing finally block. Update its stale “already renamed away” comment. A filesystem without hard-link support will now fail migration visibly instead of risking canonical replacement; this is the failure outcome already authorized by the review, not a new portability policy. Queue contents and serialization require no migration.

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
- Preserve the existing migration test that publishes a winner via `hooks.beforePublish`, plus normal migration, dry-run, and legacy-file preservation tests. Do not replace those integration assertions with mocked filesystem behavior.

## Proof plan

The preparation probe above establishes the current race, not a passing implementation. During the build, run `npx vitest run` targeting `we:scripts/conveyor/__tests__/queue-store.test.mjs` (translate the repository-prefixed reference to its checkout-relative argument).

First add only the dependency seam and new tests while retaining the fallback: the unsupported-link/absent-destination cases must fail. Then remove the fallback and run the full matching test file; all cases must pass. Record the red and green outcomes and named tests. As a mutation check, restore the old fallback while retaining the seam: the regression cases must fail again; restore the fix afterward. This proves the tests detect unsafe fallback publication rather than merely exercising the injected function.

Run `npm run check:standards` for the implementation change. Review the final diff to confirm no overwrite primitive remains in this helper and that the ordinary overwrite helper is unchanged. Independent review should inspect error outcomes, winner bytes, complete-content publication, and cleanup; runner-owned preparation checks and stamping remain separate.

## Done when

1. Must 1: existing two-argument callers pass unchanged, and tests can supply the link operation without global filesystem mocks.
2. Must 2: EEXIST returns false; EPERM, ENOTSUP, EXDEV, and EIO propagate the original error; a winning canonical file is never replaced; failed publication leaves an absent destination absent and removes its temporary file.
3. Must 3: the targeted Vitest run described in Proof plan fails with the old fallback and passes with the fix, including all existing migration cases; the standards gate passes.

## Follow-ups

No follow-up is required to complete this guard. The original suggestion to inspect every new catch branch is broader review practice, not a substitute for these tests and not part of this two-file change. Any future hard-link-free publication support must demonstrate both exclusive ownership and fully written contents before replacing the fail-without-publication behavior.
