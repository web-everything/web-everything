---
bornAs: x4mfp16
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-rules*.test.mjs", "we:scripts/__tests__/check-standards*.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-18"
preparedAgainstSha: "e7f77faff7ddc78e2d3f0bbc923edc8b1dda3958"
tags: []
---


# File the prevention guard(s) owed by chalbert/web-everything#2937's independent review

Preserve the approved prevention goal: disable rename detection for name-only membership diffs, enforce that invariant with a standards guard and real-Git regression, and document the upstream-only dependency limitation with a separate follow-up.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2937@71a77e4bfb1f9db122e4690e9801a06a0419ea1c

## Progress

Re-preparation: the old premise was four missing flags and an overlap regression expected to fail on the current implementation. Corrected premise: commit bbae6f237a already supplied overlap flags; `we:scripts/lib/verify-lane-gate.mjs:728` and `we:scripts/lib/verify-lane-gate.mjs:737` carry them, as does the card-only listing at `we:scripts/lib/verify-lane-gate.mjs:325`. Only the working-tree listings at `we:scripts/lib/verify-lane-gate.mjs:583` and `we:scripts/lib/verify-lane-gate.mjs:584` still need flags. The guard and real-Git prevention coverage remain owed. The overlap regression therefore needs a deliberate missing-flag mutation for red proof, not a false claim that current overlap behavior fails.

Old scope: gate implementation/tests plus standards rule/runner and matching test families. Corrected scope retains those files but narrows runtime edits to two flags and the misleading dependency and null-result comments. Keep size 3: estimated touch set is roughly 20 gate lines, 130 gate-test lines, 70 pure-rule lines, 20 runner lines, and 100 lines across two new standards tests. These are preparation estimates, not measured implementation changes; this story does not receive estimatedLoc.

The dependency comment at `we:scripts/lib/verify-lane-gate.mjs:700` incorrectly describes targets as graph reachability. The actual target union is selection inputs plus textual references at `we:scripts/lib/verify-lane-gate.mjs:502`; `testsNaming` uses Git grep at `we:scripts/lib/verify-lane-gate.mjs:775`. Correct that assertion while retaining the accepted upstream-only limitation at `we:scripts/lib/verify-lane-gate.mjs:693`. Existing overlap tests use a fake that strips flags at `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:449`; they cannot prove real rename detection.

Caller drift matters: `resolveGateFromBase` consumes the changed set at `we:scripts/lib/verify-lane-gate.mjs:451`, and broad/deleted selections now block with explicit affected-gate/CI guidance at `we:scripts/lib/verify-lane-gate.mjs:489`, rather than automatically running the full suite as the old plan implied. Direct working-tree consumers also exist at `we:scripts/verify-lane.mjs:395` and `we:scripts/verify-lane.mjs:963`. Overlap consumers remain `we:scripts/verify-lane.mjs:246`, `we:scripts/verify-lane.mjs:254`, and `we:scripts/pr-land.mjs:784`; no caller edits or default-policy changes are planned.

Pure-rule and wiring precedents are `we:scripts/__tests__/check-standards-rules-githook-flags.test.mjs:14` and `we:scripts/__tests__/check-standards-scoped-file-scan.test.mjs:16`. Fail-closed scanner reporting is wired at `we:scripts/check-standards.mjs:3233`. Parser reuse is grounded in `we:scripts/check-standards-rules.mjs:4655`. Research was source inspection, not a passing runtime probe. Existing preparation stamps are left untouched for the runner.

Current-tree correction: the earlier preparation cited pre-move line numbers and described only selection inputs plus textual references. Those inputs still form `targets`, but `we:scripts/lib/verify-lane-gate.mjs:508` now passes them to bounded import-graph selection at `we:scripts/lib/verify-lane-gate.mjs:549`; neither the input targets nor the selected tests are a dependency closure used by overlap. The overlap implementation at `we:scripts/lib/verify-lane-gate.mjs:718` still uses path membership. Also correct the stale null-result comment at `we:scripts/lib/verify-lane-gate.mjs:572`: the default resolver blocks unknown selection rather than launching the full suite. This adds a documentation correction within the existing scope and retains size 3. No dependency-policy fork is needed to ship the approved rename guard. No implementation tests were run during this card-only preparation; the runner owns checks and stamping.

## Design

Add explicit `--no-renames` to both `localChangedSet` diffs. Preserve pinned revisions, deletion filtering, untracked inclusion, sorting, and null-on-Git-failure behavior. Preserve the overlap union, ancestor check, explicit SHAs, doc-path exclusion and existing flags. Rename membership must include both old and new code paths independently of Git rename configuration.

Add a pure rule in `we:scripts/check-standards-rules.mjs` and wire it in `we:scripts/check-standards.mjs`. Parse executable literal `runGit` argument arrays in `we:scripts/lib/verify-lane-gate.mjs`; every diff/name-only call requires the flag. Reuse the existing TypeScript parser approach in the rules module, avoiding regex matches on prose. Accept either quote style, multiline arrays and any flag position. Inspect every matching call, including future additions, without a fixed count. Return source-attributed line findings. Parse errors and unreadable enrolled source must produce actionable failures, never a clean scan; operator remedy is to restore readable, parseable source and rerun. For a recognized diff/name-only call, dynamic revision operands are allowed, but spreads or computed option operands that prevent verifying the required flag must produce an incomplete-evidence finding. A literal flag after the Git `--` separator does not satisfy the invariant. No arbitrary scan-size bound is introduced.

Correct the dependency and null-result comments without changing carry-forward or default-selection policy. Distinguish selection inputs, bounded selected tests, and dependency closure. An empty overlap is only the membership proxy, not proof of dependency safety. File/link a separate follow-up at implementation close-out; no graph policy is selected here.

## MVP

1. Update the two remaining flags and the dependency/null-result comments in `we:scripts/lib/verify-lane-gate.mjs`.
2. Extend `we:scripts/lib/__tests__/verify-lane-gate.test.mjs` with real-Git fixtures and strict argv assertions; preserve revision/path-separator checks when updating mocks.
3. Add the pure rule and runner wiring with `we:scripts/__tests__/check-standards-rules-lane-no-renames.test.mjs` and `we:scripts/__tests__/check-standards-lane-no-renames.test.mjs`. The latter must exercise reporting, including unreadable input and local file attribution, rather than merely asserting an import string exists.
4. File or link the follow-up described below and record its identifier in this card. Preparation creates no additional card.

## Acceptance

[A1] Executable — `working-tree rename includes deleted source and blocks default selection` in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: real Git with rename detection enabled exposes both paths and the deleted original; `resolveDefaultGate` returns the existing blocked outcome with affected-gate/CI guidance. This new test must fail before the two flag additions and pass after. Repeat with detection disabled. Changed default selection inputs, including the since-last-green path through the shared resolver, must retain deletion blocking.

[A2] Executable — `every membership diff requires no-renames` in `we:scripts/__tests__/check-standards-rules-lane-no-renames.test.mjs` and `runner reports missing membership flag` in `we:scripts/__tests__/check-standards-lane-no-renames.test.mjs`: missing implementation/export/wiring fails before build; fixtures reject an unflagged call even beside compliant calls, while comments, prose and unrelated diffs remain clean. Reject a required flag appearing only after the Git path separator; cover both quote styles, multiline arrays and every valid option position. Removing any one live required flag after build must fail the guard.

[A3] Executable — `unreadable or unparseable enrolled gate fails closed` in `we:scripts/__tests__/check-standards-lane-no-renames.test.mjs`: fails with absent wiring before build, passes after, and checks an actionable source-attributed failure survives local file filtering. Include a parseable but incomplete membership argument array (for example a spread hiding flags): report that membership safety cannot be established instead of silently passing it; restore explicit literal membership flags as the operator remedy. Pure parse-error and incomplete-array coverage belongs in `we:scripts/__tests__/check-standards-rules-lane-no-renames.test.mjs`.

[A4] Executable — `real Git rename then revert invalidates recorded green` in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: assert both code paths in overlap with another lane edit retained. Current overlap code should already pass; removing its existing flags is the explicit before-build mutation that must fail, and restoration must pass. Pair with Git-failure/null and pinned-SHA assertions to preserve caller contracts.

[A5] Executable — `dependency limitation documentation matches selection inputs` in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: rejects the current graph-reachability claim and requires the corrected limitation text and rejects the stale null-result full-suite claim, failing before the comment fix and passing after. Pair with `upstream-only imported dependency remains outside overlap`, a real-Git characterization expected to pass both before and after, plus a lane-module-edit positive control. Do not present characterization as a dependency fix.

## Test plan

Use isolated repositories under the task TMPDIR, local Git identity/configuration, throwing bounded `execFileSync` adapters and unconditional cleanup. Use identical content for rename detection. For working-tree coverage, stage a code-file rename and verify changed/deleted membership under both rename settings; test the resolver with deterministic selection settings, including since-last-green eligibility. Keep mocks strict about revisions rather than swallowing arbitrary argv changes.

For overlap, commit a lane rename and an independent code edit, record the SHA, then revert only the rename. For dependency characterization, edit a lane module importing a dependency, record it, advance base only in the dependency, merge base into the lane and pass the advanced base explicitly. Expect empty overlap; a later edit to the lane module must produce overlap. Retain unreadable-ref, non-ancestor, ordinary-revert and explicit-SHA cases.

Scanner fixtures cover multiline/single/double quotes, flag ordering, multiple calls, comments/prose, patch/status diffs and syntax failures, incomplete option evidence, and a flag placed after the Git path separator. Runner fixtures exercise actual diagnostics with compliant, missing-flag and unreadable input, and local scoping. No production caller changes are needed.

Run only affected tests through `we:scripts/readiness/heavy-admission.mjs`, using its `run -- npx vitest run` command with the three test paths named in MVP (remove the documentation-only `we:` prefix when supplying CLI arguments). Run `npm run check:standards` through the same queue. If busy, wait once using `run --wait-ms=60000 --` (supported by `we:scripts/readiness/heavy-admission.mjs:3238`), then stop and report if still unavailable; no polling.

## Proof plan

Capture the working-tree rename test failing on the current implementation and passing after the two additions. Do not claim the already-flagged overlap code is red: capture its explicit missing-flag mutation failing and restored code passing. Temporarily remove each required flag to exercise the scanner, and run the queued standards gate with one mutation to prove wiring; restore all mutations. Capture unreadable/parse-error diagnostics and the dependency-comment red/green check. Record commands, exit statuses and unrelated gate failures separately. Retain no mutation diff. Existing carry-forward callers and null-on-Git-failure behavior are preservation checks, not new policy.

## Follow-ups

At implementation close-out, file/link dependency-aware marker invalidation, using the upstream-import fixture as the counterexample. Research changed paths, selected tests and actual dependency reachability; direct intersection with selection targets is insufficient. Specify unknown-graph and broad-selection handling before changing carry-forward policy. This follow-up does not block shipping the prevention guard and is not implemented here.

Broader guard enrollment requires an explicit audit of other membership consumers. Rename-aware presentation diffs remain outside this guard.
