---
bornAs: x4mfp16
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/verify-lane-gate.mjs", "we:scripts/lib/__tests__/verify-lane-gate.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/check-standards.mjs", "we:scripts/__tests__/check-standards-rules*.test.mjs", "we:scripts/__tests__/check-standards*.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-10-09"
preparedAgainstSha: "0007875ad3f13546d089e71c49a89d50264feb15"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2937's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/verify-lane-gate.mjs:345` and `we:scripts/lib/verify-lane-gate.mjs:350` — require `--no-renames` on the name-only diffs feeding overlap membership, enforce it with a standards guard, and add a real-Git rename-then-revert regression.
2. `we:scripts/lib/verify-lane-gate.mjs:307` — pin the documented upstream-only dependency carry-forward limitation and file a follow-up for dependency-aware invalidation. `resolveDefaultGate` supplies selection inputs, not an expanded dependency graph; intersecting those inputs alone is not a demonstrated solution.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2937@71a77e4bfb1f9db122e4690e9801a06a0419ea1c

## Progress

Prepare-validation repair: the prior prepared scope assigned both standards-rule fixtures and runner wiring coverage to planned `we:scripts/lib/__tests__/verify-lane-gate-no-renames.test.mjs`, which did not satisfy the matching test scope for the two standards sources. Corrected scope enrolls `we:scripts/__tests__/check-standards-rules*.test.mjs` and `we:scripts/__tests__/check-standards*.test.mjs`. Existing `we:scripts/__tests__/check-standards-rules-githook-flags.test.mjs` imports pure rules from `we:scripts/check-standards-rules.mjs`; existing `we:scripts/__tests__/check-standards-scoped-file-scan.test.mjs` checks wiring in `we:scripts/check-standards.mjs`. Follow these established locations with the two planned tests below. The prevention goal and source scope are unchanged.

Preparation research: the original scope named only the gate module and its existing unit test, with historical citations at lines 268 and 260. The current overlap implementation is `laneRelevantChangeSince` at `we:scripts/lib/verify-lane-gate.mjs:332`; its two name-only diff sites still omit `--no-renames` at lines 345 and 350. The same module's `localChangedSet` builds sets from two more name-only diff sites at `we:scripts/lib/verify-lane-gate.mjs:200` and `we:scripts/lib/verify-lane-gate.mjs:201`. Corrected scope includes those four sites, standards-rule implementation/wiring, and matching tests. This is undelivered prevention work, not merely a stale citation.

The existing overlap tests at `we:scripts/lib/__tests__/verify-lane-gate.test.mjs:340` use `fakeCommitGit`; they cover ordinary reverts and out-of-scope merges but do not exercise Git rename detection. Their positional argument matching will need updating when the flag is inserted.

The original follow-up premise implied that `resolveDefaultGate` exposes dependency reachability through its targets. Source evidence narrows that claim: at `we:scripts/lib/verify-lane-gate.mjs:169`, targets are the union of changed selection inputs and tests found by textual references; `testsNaming` at `we:scripts/lib/verify-lane-gate.mjs:385` uses `git grep`. The import walk happens later inside `vitest related`. Keep the accepted limitation documented at `we:scripts/lib/verify-lane-gate.mjs:307`, characterize it, and carry dependency-aware invalidation into a separate follow-up without choosing its policy here.

The standards runner already separates pure rule logic from filesystem reads, as shown by its code-guard wiring at `we:scripts/check-standards.mjs:2648`. Extend that structure. Research here is source inspection; the real-Git regression and mutation proof below remain implementation deliverables, not claimed passing results.

Re-prepare 2026-10-09 (stale `preparedAgainstSha`; premise re-checked against `origin/main` 0007875ad): still undelivered — the gate module has no `--no-renames` at the four set-membership sites. Citations drifted; current ones: `localChangedSet` at `we:scripts/lib/verify-lane-gate.mjs:438` (diffs at lines 443-444), `laneRelevantChangeSince` at `we:scripts/lib/verify-lane-gate.mjs:578` (diffs at lines 588 and 593), the upstream-only limitation documented in the doc comment at `we:scripts/lib/verify-lane-gate.mjs:552`, `resolveDefaultGate` at `we:scripts/lib/verify-lane-gate.mjs:313` with `testsNaming` at `we:scripts/lib/verify-lane-gate.mjs:628`. A fifth diff at `we:scripts/lib/verify-lane-gate.mjs:249` already carries `--no-renames`; the standards rule must accept it. Wiring precedent in the runner: `we:scripts/check-standards.mjs:3012`. Design, MVP, Test plan, Proof plan and Follow-ups are otherwise unchanged and still hold; read every "line 200/201/345/350/307/169/385" above as the current line named here.

## Design

Make every name-only diff used by `localChangedSet` and `laneRelevantChangeSince` explicitly disable rename detection. A rename must contribute both deletion and addition paths to membership sets, regardless of repository or user rename configuration. Preserve the record/head relevance union, pinned merge bases, trailing revision/path separator where present, sorting, and fail-closed handling.

Add a pure standards rule in `we:scripts/check-standards-rules.mjs`, wired by `we:scripts/check-standards.mjs`, checking executable literal `runGit` argument arrays in `we:scripts/lib/verify-lane-gate.mjs`. Every array selecting `diff` and `--name-only` must include `--no-renames`. Cover new matching calls in this module automatically rather than hard-coding line numbers or the current count. Ignore comments and prose strings; handle multiline arrays and either quote style. Report an actionable file/line finding attributed to the gate module, so local file scoping can retain it. This bounded enrollment covers the known set-membership family; it does not pretend a textual repository-wide search can infer every diff consumer's semantics.

Keep upstream-only dependency carry-forward unchanged in this item. An imported dependency changed solely by the base branch is excluded by the current membership proxy even when the importing lane file differs from base. A characterization test records this limitation explicitly; it must not imply that an empty overlap proves dependency safety.

## MVP

1. Add `--no-renames` to all four name-only diff sites in `we:scripts/lib/verify-lane-gate.mjs`. Adjust Git argument mocks in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs` to recognize the flags without silently accepting incorrect revision arguments.
2. Implement and wire the standards rule described above. Add `we:scripts/__tests__/check-standards-rules-lane-no-renames.test.mjs` for pure scanner fixtures matching `we:scripts/check-standards-rules.mjs`, and `we:scripts/__tests__/check-standards-lane-no-renames.test.mjs` for runner wiring coverage matching `we:scripts/check-standards.mjs`. The existing gate test matches `we:scripts/lib/verify-lane-gate.mjs`.
3. Add isolated temporary-repository tests to `we:scripts/lib/__tests__/verify-lane-gate.test.mjs` for rename/revert and an upstream-only imported dependency. Use real Git through a throwing `execFileSync` adapter, local fixture identity/configuration, and cleanup after each case.
4. At implementation close-out, file or link the dependency-aware invalidation follow-up described below. This preparation only records its required content; it creates no additional card.

## Test plan

- Scanner fixtures in `we:scripts/__tests__/check-standards-rules-lane-no-renames.test.mjs`: reject a name-only diff missing the flag, accept one containing it in different flag positions, cover multiline and single/double quotes, ignore comments and unrelated strings, and leave patch/status diffs alone. Include multiple calls so one compliant call cannot mask a second violation. In `we:scripts/__tests__/check-standards-lane-no-renames.test.mjs`, verify the standards runner loads and reports the rule against the actual enrolled source.
- Real-Git rename/revert in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: seed a base file, rename it on the lane, record that commit, then revert only the rename. Keep another lane edit throughout so the head still differs from base. Explicitly enable rename detection and use unchanged file content so detection is reliable. Assert both old and new paths appear in the overlap, forcing re-verification. Repeat with rename detection disabled to prove configuration independence. The current implementation should fail the enabled-detection case; capture the actual result rather than assuming it.
- Selection coverage in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: a rename exposes both names through `localChangedSet`, including the deleted original in `deletedFiles`, and preserves the existing deletion fallback behavior.
- Dependency characterization in `we:scripts/lib/__tests__/verify-lane-gate.test.mjs`: a lane edits a module that imports an unchanged dependency; record the lane commit, advance base by changing only that dependency, then merge base into the lane. Pass the advanced base explicitly and assert an empty overlap. Add a positive control where the lane-owned module changes after recording and produces a nonempty overlap.
- Retain existing coverage for missing/unreadable refs, explicit SHA pinning, ordinary lane reverts, and unrelated base merges. Run `npx vitest run verify-lane-gate check-standards-rules-lane-no-renames check-standards-lane-no-renames`, which selects the existing gate tests and both planned standards test files, followed by `npm run check:standards`.

## Proof plan

During implementation, first run the new rename/revert test against the unmodified gate and retain the observed failure. Run the same test after the flag changes and retain its passing output. The fixture must use real Git; a mock that supplies both names cannot prove rename behavior.

Prove the guard is connected by temporarily removing one required flag from the gate module: the scanner test and `npm run check:standards` must identify the offending call. Restore the flag and rerun both successfully. Perform this mutation only in the implementation lane and retain no mutation diff. Record the dependency characterization separately as evidence of the current limitation, not as evidence it has been fixed. Record commands, exit statuses, and any unrelated gate failures in the delivery evidence.

## Follow-ups

File or link a separate item for dependency-aware marker invalidation, preserving this item's upstream-import fixture as its starting counterexample. It must research the relationship between changed paths, selected tests, and the actual dependency graph; direct intersection with `resolveDefaultGate` input targets is insufficient evidence. Specify handling of full-suite selection and unavailable graph information before changing carry-forward behavior. Do not implement that policy in this prevention item.

Broader enrollment of other name-only set-membership consumers can follow an explicit consumer audit; this guard initially covers the four known gate-module sites. No blanket ban on rename-aware diffs used for presentation is intended.

## Done when

The real-Git rename/revert regression fails on the old implementation and passes with explicit `--no-renames`; the standards guard detects removal of that flag; all targeted tests and the standards gate pass; and the upstream-only dependency limitation has a passing characterization plus a linked follow-up. No dependency-aware invalidation is claimed delivered by this item.
