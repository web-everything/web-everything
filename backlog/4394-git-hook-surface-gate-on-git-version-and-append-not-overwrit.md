---
bornAs: xuqixrd
kind: story
size: 2
status: resolved
scope: ["we:scripts/lib/git-hook-surface.mjs", "we:scripts/lib/__tests__/git-hook-surface*.test.mjs"]
dateOpened: "2026-09-29"
dateResolved: "2026-10-03"
preparedDate: "2026-09-30"
preparedAgainstSha: "a71991b2be161a3d53ddce8d10af6d9154c601bd"
tags: []
---

# git-hook-surface: gate on git version and append (not overwrite) GIT_CONFIG_COUNT

Advisory follow-up from PR #2867 (WE #4291): preserve the caller's counted Git environment configuration while disabling traditional hooks, and refuse Git versions that cannot honor that override. The defect remains in `we:scripts/lib/git-hook-surface.mjs:48-63`; the existing tests must change alongside the helper.

## Progress

- **Implementation / before-after proof (2026-10-03):** updated only `we:scripts/lib/git-hook-surface.mjs` and `we:scripts/lib/__tests__/git-hook-surface.test.mjs`. The helper preserves counted pairs, validates count/pair completeness, appends one override, and probes the appended environment (preserving the supplied PATH and counted pairs) with a shell-free, five-second, bounded-output Git version check. Initialization errors omit values/output; cleanup behavior and the compatibility template remain intact.
- **Regression proof:** `npx vitest run we:scripts/lib/__tests__/git-hook-surface.test.mjs` (remove the `we:` locus prefix when executing from the repository root): original suite **22/22 passed**; final regression suite against the original helper **29 failed / 25 passed (54 total)**; fixed helper **54/54 passed**. Exact red-to-green cases include `preserves caller pairs and appends exactly once on repeated application`, `refuses unsupported or ambiguous Git 2.30.9 before a protected operation`, and ``executes on a plain `git commit`, but is inert once the process env is withHooksDisabled``. The other failures cover malformed counts, missing pairs, probe invocation/options, vendor versions, ambiguous versions (including extra newlines), probe failures and cross-PATH cache refusal. The repeated-application case exercises ten successive appends while checking every preceding pair and the frozen original input.
- **Separate simulated refusal proof:** filtered invocation of `we:scripts/lib/__tests__/git-hook-surface.test.mjs` covering unsupported/ambiguous versions, probe errors and changed PATH produced **10 passed / 44 skipped**, independently of the real-Git cases. Probe-error callbacks were not invoked, and the exact sanitized diagnostic excluded the injected secret output.
- **Caller regression found and fixed by lane verification:** the first full gate flagged two cases in unchanged `we:scripts/operations/__tests__/probation-run-realio.test.mjs`: the new version probe lacked the hook override. The helper now constructs the appended environment before probing and returns it only after the version prerequisite passes. This preserves caller configuration/PATH while satisfying the existing all-launcher-subprocess protection contract. Focused rerun of that suite plus `we:scripts/lib/__tests__/git-hook-surface.test.mjs` passed **63/63 tests in 2 files**; no caller test was changed.
- **Lane verification blocker:** `node we:scripts/verify-lane.mjs` ran **7105 tests in 160 files**, initially reporting **7097 passed / 8 failed**. Two were the caller regressions fixed above. The remaining six are process-table cases in `we:scripts/operations/__tests__/restart-runner-io-real.test.mjs` and `we:scripts/operations/__tests__/clear-stuck-session-io-real.test.mjs`. Running these two unchanged suites against the original helper reproduced **6 failed / 11 passed**. A direct `spawnSync` probe of `ps -o ppid=,command= -p <own-pid>` returned `EPERM` with no child exit status: this sandbox denies process-table access. No tests or gates were skipped or weakened. The lane marker remains red; completion/resolution is pending verification in an environment permitting these real process-table probes.
- **Standards gate:** `npm run check:standards` exited 0 before and after the caller-probe correction; final run: **0 errors / 5561 warnings**, checking 4947 backlog items.
- **Real-Git proof:** the independent temporary-repository fixture observed caller key `probe.preserved=yes`, effective `core.hooksPath=/dev/null`, marker presence after the clean-environment positive-control commit, and marker absence after the protected commit despite an earlier counted hooks-path entry pointing at the planted hook. The existing on-disk hooks-path rewrite case also passed. These observations cover traditional hooks only.

- **Original premise/scope:** the card cited `we:scripts/lib/git-hook-surface.mjs:52` for an unconditional count of one and no version gate, and scoped only that source file. Its acceptance command was a TODO.
- **Corrected premise/scope:** the constant is at `we:scripts/lib/git-hook-surface.mjs:48-52`; `withHooksDisabled` overlays it at lines 61-63. The helper neither appends nor probes Git. The existing overwrite expectation is in `we:scripts/lib/__tests__/git-hook-surface.test.mjs:29-36`; add that test family to scope. No source relocation or wider launcher change is required: both callers construct their launcher environment through the helper in `we:scripts/operations/probation-build-run.mjs:692-694` and `we:scripts/operations/probation-heal-run.mjs:228-230` before returning their I/O adapters.
- **Observed evidence:** a read-only Node import invoked the current helper with count `1`, key `probe.preserved`, and value `yes`. The returned environment instead had count `1`, key `core.hooksPath`, and value `/dev/null`; the input remained unchanged. Thus the preservation goal is not already delivered. Source inspection found no version check in the helper.
- **Compatibility evidence:** [Git 2.31 release notes](https://raw.githubusercontent.com/git/git/v2.31.0/Documentation/RelNotes/2.31.0.txt) document the introduction of the environment configuration mechanisms. The existing module header already states Git >=2.31. This work enforces that stated prerequisite, using the refusal option already allowed by the original card.

## Design

Keep `withHooksDisabled(env = {})` as the shared entry point in `we:scripts/lib/git-hook-surface.mjs`. Return a fresh environment preserving unrelated variables and every counted key/value pair. Interpret an absent or empty `GIT_CONFIG_COUNT` as zero; otherwise require a nonnegative decimal integer within Git's signed-int count range, leaving room for one appended entry. Reject malformed counts and missing counted keys/values with a diagnostic that names the problem without printing configuration values. Empty values are valid. Append `core.hooksPath=/dev/null` at index N and set count to N+1. An earlier counted hooks-path value must remain present but be superseded by the appended entry.

Before returning a protected environment, run `git --version` synchronously with the supplied environment so executable lookup uses the same PATH as the consuming subprocess. Require a parseable stable version >=2.31.0; accept ordinary vendor suffixes (Apple Git and Windows), and refuse older versions, ambiguous output, unavailable Git, and probe failures. Use a bounded timeout and no shell. Avoid a process-global success cache that would silently apply across different PATH values. Refusal throws a concise initialization error; never return an unprotected environment or silently drop the caller's configuration. This is the original card's refusal route, preserving protection for descendant Git commands without introducing a per-command fallback.

Update the helper's JSDoc and module header in `we:scripts/lib/git-hook-surface.mjs`: it is no longer pure, and initialization refusal is an explicit exception to the broad current no-throw statement. Keep snapshot/reset cleanup contracts unchanged. Retain `HOOKS_DISABLED_ENV` for compatibility as the zero-entry template, documenting that the constant alone does not perform the prerequisite check. Production callers already use the helper. The existing worker/checker versus launcher environment separation remains intact.

## MVP

1. Implement count validation, nonmutating append, and the bounded Git version prerequisite in `we:scripts/lib/git-hook-surface.mjs`.
2. Replace the overwrite expectation and add preservation, refusal, and version cases in `we:scripts/lib/__tests__/git-hook-surface.test.mjs` (or a focused sibling matching `we:scripts/lib/__tests__/git-hook-surface*.test.mjs`).
3. Extend the existing real-Git hook fixture to combine a caller configuration entry, an earlier counted hooks-path value, and the appended override. Keep implementation changes inside the declared source/test scope.

## Test plan

- In `we:scripts/lib/__tests__/git-hook-surface.test.mjs`, exercise absent/empty/zero count, multiple entries, duplicate hooks-path entries, unrelated variables, empty values, and repeated application. Assert input immutability, original pair preservation, and exactly one appended entry per call.
- Reject negative, fractional, nonnumeric, unsafe/overflowing counts and incomplete counted pairs. Check diagnostics do not expose values.
- Exercise versions 2.30.x (refuse), 2.31.0 (accept), newer stable releases, Apple/Windows suffixes, malformed output, command failure, missing executable, and timeout. Use controlled temporary executables on PATH or a scoped subprocess spy for these deterministic cases; verify the supplied environment and bounded probe options. Restore all test state.
- Keep real-Git assertions independent of those doubles: in a temporary repository, query an unrelated caller key and effective hooks path through the returned environment. Expect the caller value and `/dev/null`, including when a previous counted entry points to the planted hook directory.
- Retain the existing real planted-hook positive control and protected-operation cases in `we:scripts/lib/__tests__/git-hook-surface.test.mjs`. Use an explicitly cleaned configuration environment for the positive control so inherited launcher configuration cannot invalidate it. Verify initialization refusal prevents the test's subsequent protected-operation callback from running.

## Proof plan

Run the affected Vitest file from the WE repository root (the test path is `we:scripts/lib/__tests__/git-hook-surface.test.mjs`) before and after implementation. The new preservation and old-version refusal cases must fail against the current helper and pass after the fix. Existing tests alone are insufficient because one currently endorses the defect. Record test counts and the exact failing/passing cases.

Use the real-Git fixture to record the nonsecret caller-key result, effective hooks path, and hook-marker absence after the protected operation, with marker presence in the positive control. Run simulated unsupported-Git coverage separately; a modern host Git pass is not evidence of old-version refusal. Temporary repository operations belong to later implementation verification, not this preparation run.

Run `npm run check:standards` after implementation and record its outcome. For preparation, the runner owns stamping and final checks. Do not infer protection against Git execution surfaces outside traditional hooks from these results.

## Done when

The affected Vitest invocation passes the new append and version-refusal regressions plus the existing hook-surface suite; real Git observes the preserved caller value and disabled hooks. Unsupported or unprobeable Git yields explicit refusal before a protected environment can be used. The standards gate passes and source comments describe the new failure contract accurately.

## Follow-ups

Testing lesson: in the Vitest version used here, subprocess doubles must cover both named and default exports and explicitly restore the real implementation after reset; otherwise a version test can miss the helper call or contaminate the real-Git fixture. This is handled locally in `we:scripts/lib/__tests__/git-hook-surface.test.mjs`.

No additional prerequisite is identified. Broader Git execution surfaces (filters, fsmonitor, and config-defined hooks) remain the separate hardening follow-up already described in `we:scripts/lib/git-hook-surface.mjs:10-15`. Supporting Git older than 2.31 through a fallback is outside this MVP; this card enforces the existing prerequisite. Do not broaden this work into launcher routing or cleanup redesign.
