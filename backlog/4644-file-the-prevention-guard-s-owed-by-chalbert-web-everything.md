---
bornAs: x1jgrge
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/lane-pool-health-watch.mjs", "we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs", "we:scripts/conveyor/__tests__/lane-pool-health-watch-prevention.test.mjs", "we:package.json", "we:package-lock.json"]
dateOpened: "2026-09-30"
preparedDate: "2026-11-19"
preparedAgainstSha: "46abe5d8e4fde88010e88f525ee7aa6a4e8f80fb"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3146's independent review

Filed mechanically on approval of chalbert/web-everything#3146 at commit `1913d2883871f7a934db6e3ae0c06215010c3fef`. The independent review owed two executable prevention guards: undefined-name detection in CI or a pre-commit hook, and branch-sensitive coverage or mutation testing that detects removal of the new logic. The approved runtime fix is already present; this item delivers the remaining guards.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3146@1913d2883871f7a934db6e3ae0c06215010c3fef

## Progress

- **Old premise/scope:** the mechanical filing cited `we:scripts/conveyor/lane-pool-health-watch.mjs:515` and `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs:101`, scoped only those two files, and left the executable acceptance command unspecified.
- **Corrected premise:** the reviewed commit added the `trackedModified` and `untracked` arguments to `isLaneAlreadyClean` inside `reclaimFinishedLanes`. The forwarded arguments are now at `we:scripts/conveyor/lane-pool-health-watch.mjs:523`; the cancellation regression is at `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs:111`. The predicate in `we:scripts/lib/lane-whois-core.mjs:213` rejects nonzero components when supplied, but retains aggregate-only compatibility when both are omitted. Removing both forwarded components therefore restores the erroneous already-clean outcome for -2 + 2. These are the guard's actual targets, not the unrelated salvage formatter added later in commit `e505317bcdfb7a6a4f06eff146cbc7fd6e54c3cd`.
- **Historical preparation evidence (not rerun in this preparation):** `npx vitest run` targeting `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs` with `-t 'components that cancel'` passed one test, with 77 skipped, during preparation. This proves the existing regression case, not completion of either prevention guard. Inspection found no active ESLint/no-undef configuration in the package scripts or CI workflow. `we:vitest.config.ts:56` excludes this watcher from coverage (it is also absent from `we:scripts/lib/trust-chain-tier.mjs`); the aggregate 80% bar is not a changed-branch gate here.
- **Corrected scope:** retain the watcher as the guarded source and its existing regression test; add the planned `we:scripts/conveyor/__tests__/lane-pool-health-watch-prevention.test.mjs` for lint enforcement and mutation checks. Add ESLint and Node globals as explicit development dependencies through `we:package.json` and `we:package-lock.json`; the new prevention test directly imports those dependencies and exercises the configured linter. Every source/config entry is thus paired with the existing watcher test or the new prevention test. No runtime-policy change is needed.


- **Current revalidation:** the old preparation assumed sibling scratch modules and direct Vitest commands. Corrected scope remains the same five entries; temporary modules instead live under `$TMPDIR`, with import relocation, and all test execution uses the host admission queue via `npm run test:unit`. The prevention test is absent from the current file inventory; direct ESLint/globals dependencies are absent from `we:package.json:106` (transitive eslint-scope in the lockfile is not ESLint enforcement). This debt is not already delivered. Runtime defaults and callers remain unchanged: `we:scripts/conveyor/lane-pool-health-watch.mjs:501` keeps reclaimPreserved and salvageEnabled false, and the guard targets its forwarded component properties only.
- **Estimate:** retain size 3. Expected touch set: new prevention test roughly 180–240 lines (lint controls, relocation, mutation verdict and cleanup cases), dependency manifest roughly 2 lines plus generated lock entries; existing watcher and regression are guarded scope entries with no planned behavior edits. The target call at `we:scripts/conveyor/lane-pool-health-watch.mjs:521` and existing cancellation fixture at `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs:111` bound this to one regression, not a repository-wide lint rollout. No new dependency edge or judgment fork is needed.

## Design

Implement a narrowly scoped prevention suite in `we:scripts/conveyor/__tests__/lane-pool-health-watch-prevention.test.mjs`, automatically collected by the existing script-test include in `we:vitest.config.ts:128`. Discovery in `we:scripts/ci/shard-assign.mjs:94` uses Vitest’s actual include/exclude rules; new files need no timing-table registration. The covered and no-coverage commands at `we:.github/workflows/ci.yml:284` and `we:.github/workflows/ci.yml:296` run assigned files, and the aggregator at `we:.github/workflows/ci.yml:396` rejects failed shards. Card-only PRs intentionally omit unit shards; the implementation’s test/dependency changes must take the non-light route. Therefore no new workflow or repository-wide lint rollout is required.

1. **Undefined names:** use ESLint's programmatic linter with module parsing, supported ECMAScript syntax, declared Node globals, and `no-undef: error`. Lint the complete current `we:scripts/conveyor/lane-pool-health-watch.mjs`, without executing its CLI. Disable inline rule suppression for this guard. Fail on parser/configuration errors as well as undefined names. Add a negative control changing the forwarded `trackedModified` value to a deliberately undeclared identifier; require a diagnostic with rule ID `no-undef` at that use. Imported identifiers and declared locals must remain accepted. Keep the configuration in the prevention test, with direct devDependencies in `we:package.json` and corresponding lock entries in `we:package-lock.json`.
2. **Removal sensitivity:** exercise the real exported `reclaimFinishedLanes` with an injected recording reclaim callback. Run identical assertions against the original module and an isolated mutant that removes BOTH forwarded component properties from the `isLaneAlreadyClean` call. Locate that call and require exactly one matching mutation site; zero or multiple matches fail rather than silently skipping proof. Removing one property alone is not the regression: the predicate rejects a missing counterpart while either component remains supplied.
3. **Honest mutation verdict:** use a unique directory under the task’s `$TMPDIR`, never overwrite tracked source, and remove the directory in a finally block. Parse static import declarations and rewrite only relative import specifiers to file URLs resolved against the original watcher URL; leave Node/package imports intact. Apply the identical relocation to the baseline, no-op control and mutant. The imports at `we:scripts/conveyor/lane-pool-health-watch.mjs:45` require this relocation; the module-relative HERE value at `we:scripts/conveyor/lane-pool-health-watch.mjs:71` must not be used by the injected reclaim-only scenarios. Importing the temporary module must leave the CLI guard at `we:scripts/conveyor/lane-pool-health-watch.mjs:747` false. Require successful import and successful baseline assertions before attempting the mutant. A mutant counts as killed only by the expected reclaim-call/outcome assertion for cancellation; a syntax/import error, timeout, or unrelated exception is a guard failure. An unchanged-source control must survive, proving that arbitrary failures are not accepted as kills.

The scoped mutation option fulfills the review's explicit coverage-or-mutation alternative. It does not change global coverage thresholds or the underlying lane preservation policy.

## MVP

- Add the prevention suite and its explicit lint dependencies. Preserve the existing cancellation regression in `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs`.
- Pin both outcomes in the prevention suite: zero components at the correct branch tip skip reclamation; cancelling nonzero components at that same tip call reclaim once and return the injected result. Also cover the reversed cancellation pair (+2, -2).
- Make the lint negative control and the removal mutant executable parts of the normal test run, not manual instructions that can be forgotten.
- Keep all callbacks fake; no pool scan, lease change, live reclaim, GitHub operation, or daemon invocation is necessary for these guards.

## Test plan

- Existing source/test pair: `we:scripts/conveyor/lane-pool-health-watch.mjs` → `we:scripts/conveyor/__tests__/lane-pool-health-watch.test.mjs` plus planned `we:scripts/conveyor/__tests__/lane-pool-health-watch-prevention.test.mjs`.
- Dependency/config pair: `we:package.json` and `we:package-lock.json` → the planned prevention test's actual ESLint/globals imports and lint controls; verify installation with `npm ci` in the implementation checkout.
- Linter cases: unchanged source passes; an undeclared forwarded identifier produces `no-undef`; a legitimate local/import is accepted; invalid syntax is rejected; inline suppression cannot hide the negative control.
- Mutation cases: baseline assertions pass; removing both components is killed by the cancellation assertion; unchanged-source control survives; missing/ambiguous mutation anchors fail; load errors are rejected rather than credited; temporary files are removed on success and failure.
- Run `npm run test:unit -- lane-pool-health-watch` to collect the existing watcher suites and the new prevention suite. Run `npm run check:standards` during implementation validation. Confirm CI collects the new file through the existing shard path.

## Proof plan

Record baseline and negative-control evidence from the implementation checkout. First show the unmodified watcher passes both new guards. Then, in disposable source copies only, introduce the undeclared identifier and record the exact `no-undef` diagnostic; remove both component arguments and record the named cancellation assertion failure. Record that a no-op mutant is rejected as surviving and an import failure is rejected as invalid evidence. Finally run the complete affected suites with the original source and show a clean result and no leftover mutant files.

The substantive red/green evidence is the two controlled defects above: each guard must reject its defective copy and accept the original. The pre-implementation tree has no prevention suite; record that absence rather than claiming a test that does not exist already fails. Do not present the already-green cancellation regression alone as proof that this prevention debt is delivered.

## Acceptance

All named cases below are to be implemented in `we:scripts/conveyor/__tests__/lane-pool-health-watch-prevention.test.mjs`. Each executable command uses the queued package entrypoint. Before implementation, the exact new test-file filter has no test file and exits nonzero; after implementation it must collect the named cases and pass. During build, also demonstrate defect-specific red/green with disposable copies; absence of a suite alone is not behavioral proof.

- [A1] Executable: `npm run test:unit -- lane-pool-health-watch-prevention -t A1` — named cases `A1 source lint` and `A1 lint controls`: whole watcher passes no-undef; undeclared forwarded name fails with its exact diagnostic; valid imports/locals pass; syntax errors, unreadable input, and attempted inline suppression fail closed. Missing dependencies/configuration errors fail the suite, never skip it.
- [A2] Executable: `npm run test:unit -- lane-pool-health-watch-prevention -t A2` — `A2 cancellation mutation`: original and relocated no-op module pass identical zero-component and both cancellation-direction assertions; removing both forwarded properties fails specifically the reclaim-call/outcome assertion. Pin callback arguments and returned outcomes with dryRun false and true. Omitted reclaimPreserved/salvageEnabled retain their false defaults; no live reclaim or CLI executes.
- [A3] Executable: `npm run test:unit -- lane-pool-health-watch-prevention -t A3` — `A3 invalid mutation evidence`: zero/multiple anchors, unreadable source, parse/import errors, unrelated assertion errors and timeouts cannot count as kills; a no-op mutant is reported as surviving. Require successful baseline/import before verdict evaluation. Operator fallback is a failing test with the specific evidence error and a request to repair the anchor/fixture, never silent acceptance.
- [A4] Executable: `npm run test:unit -- lane-pool-health-watch-prevention -t A4` — `A4 isolated cleanup`: fixtures stay under `$TMPDIR`, import relocation preserves the baseline, and finally cleanup removes all fixture files on success and injected failure; tracked source bytes remain identical. An unavailable temporary root fails explicitly, without falling back to a repository sibling.
- [A5] Executable: `npm run test:unit -- lane-pool-health-watch-prevention -t A5` — `A5 CI discovery`: use the existing unit discovery export from `we:scripts/ci/shard-assign.mjs:94` and assert this exact test file is included, so the CI shard assignment sees it. The pre-build missing suite fails; the completed suite is discovered and runs through the existing non-light CI path. Verify `npm ci` succeeds with the explicit dependencies and lockfile, then run `npm run test:unit -- lane-pool-health-watch` to retain the existing caller regressions.

## Follow-ups

No prerequisite judgment call remains. Repository-wide lint adoption, broader mutation testing, and a changed-branch coverage policy are separate work if requested; this item establishes only the two guards owed for the reviewed watcher change. If the call site is refactored later, update the mutation anchor and preserve its fail-closed missing/ambiguous-site checks and cancellation proof.
