---
bornAs: xezin1k
kind: story
size: 3
parent: "4075"
status: resolved
scope: ["we:scripts/lib/isolation-provider.mjs", "we:scripts/lib/__tests__/isolation-provider.test.mjs", "we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs", "we:scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs", "we:scripts/operations/__tests__/helpers/codex-sandbox-fixture.mjs", "we:.github/workflows/codex-sandbox-proof.yml", "we:scripts/operations/__tests__/codex-sandbox-proof-workflow.test.mjs"]
dateOpened: "2026-10-01"
dateStarted: "2026-10-06"
dateResolved: "2026-10-06"
preparedDate: "2026-10-03"
preparedAgainstSha: "90837f5123f59dc02e9af0d79a3c1b33cf0cd7fb"
tags: []
---

# Prevention — trustworthy live sandbox fixtures and process-result checks

Filed mechanically on approval of chalbert/web-everything#3376. Preserve the three owed guards: repair the split JSDoc through review, mirror production topology in sandbox-proof fixtures and run them in opt-in CI on CLI upgrades, and enforce explicit spawned-process error checks. This is prevention work, not a change to sandbox permissions.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3376@b88de0fed344d16aff047e3277f10d5ded753a73

## Progress

- **Old premise/scope:** the filing cited `we:scripts/lib/isolation-provider.mjs:353` for a split comment and `we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs:29` for unchecked Git setup. It suggested production used `resolveLane` / `git worktree add`. Scope named only the provider and two existing test files; no CI wiring or process-check guard was identified.
- **Corrected premise:** the split remains at `we:scripts/lib/isolation-provider.mjs:353–362`: “Chosen over” is separated from its `--add-dir` explanation by the Git-metadata paragraph. The live suite still calls unchecked `spawnSync` for Git initialization at `we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs:29`; its negative cases accept any status unequal to zero, including a null status from launch failure or a signal. The positive control checks its own launch only, not every later probe.
- **Topology evidence:** `we:scripts/lane-pool.mjs:5–17` documents independent clones and reference-object sharing; provisioning calls `git clone` with reference arguments at `we:scripts/lane-pool.mjs:831–833`. The current resolver is `resolveLanePath` in `we:scripts/operations/minimal-context-provider.mjs:462–470`; it reads pool status, rather than creating a worktree. `we:scripts/operations/deliver-item-wrapper.mjs:969–970` also explicitly identifies pooled lanes as clones. Therefore adding linked worktrees would reproduce an obsolete premise. Existing standalone fixtures have the right directory-shaped Git metadata but do not exercise clone/reference topology.
- **Corrected scope:** retain the provider comment repair and existing argument tests; replace scratch initialization-only fixtures with disposable clone/reference fixtures. Add a shared test helper, its matching guard tests, and a dedicated manual CI workflow with matching workflow tests. The process lint is bounded to this proof suite and helper, where the unchecked calls were observed; no repository-wide subprocess-policy migration is implied by the uncited original bullet. Searches found no existing CI invocation of `WE_CODEX_SANDBOX_TEST`. All added paths in scope are planned; production lane provisioning and resolution are read-only evidence.
- Research establishes outstanding work, not an already-delivered goal. No live sandbox run was performed during preparation; the existing JSDoc's CLI-version claims remain historical evidence only.

## Design

1. Rejoin the `writableRoots` explanation in `we:scripts/lib/isolation-provider.mjs` so the `--add-dir` comparison precedes the separate Git-metadata paragraph. Keep the distinction between cooperative agent behavior and raw OS enforcement. Do not add a deterministic prose gate. Preserve the explicit untested linked-worktree and symlink limits unless separately proven.
2. Put disposable fixture construction and checked subprocess execution in planned `we:scripts/operations/__tests__/helpers/codex-sandbox-fixture.mjs`. Create committed local seed repositories and independent implementation/WE lane clones using Git's reference option, mirroring current production without acquiring a real pool or touching user repositories. Keep fixtures below the real home directory, outside ambient writable temporary roots; preserve the ungranted sibling and read-denied target. Verify directory-shaped Git metadata, resolved Git directory/common directory, and the reference-object relationship before probes. Resolve paths canonically and quote shell paths safely, including spaces and apostrophes. Clean up only the fixture-owned root, including after setup failure.
3. Route every Git/CLI subprocess in the suite through that helper. Reject `error`, signals, null/non-integer statuses, and timeouts before classifying a result. Setup and positive controls require status zero; denial cases require a nonzero integer status and unchanged filesystem state. Include command, exit status, signal, stdout and stderr in failure diagnostics. A failed process launch is never sandbox-denial evidence.
4. In planned `we:scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs`, add a bounded syntax guard using the existing TypeScript parser dependency: the live suite must not import or invoke raw child-process APIs; the helper's sole raw spawn site must feed the checked-result boundary. Reject bypass fixtures and pin boundary behavior with injected subprocess results. This enforces explicit process checks for the affected proof path without attempting general interprocedural linting across the repository.
5. Add planned `we:.github/workflows/codex-sandbox-proof.yml`, manual-dispatch only, on macOS for the documented Seatbelt claim. Require an explicit CLI-version input, install that exact version, print the actual version and host, install the existing WE/FUI sibling dependencies, and run only the named proof/guard tests with both opt-in environment variables. No model call or authentication should be needed for the raw sandbox wrapper. A requested run must fail on missing CLI, unsupported sandbox, or any skipped live suite; no continue-on-error. Upload the test report and CLI/host evidence even on failure. CLI upgrades are validated by dispatching this workflow with the candidate version.

## MVP

- Repair the JSDoc sentence and retain existing `buildNativeDenyCodexArgs` behavior, verified by `we:scripts/lib/__tests__/isolation-provider.test.mjs`.
- Replace fixture setup in `we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs` with the checked clone helper. Retain ordinary backlog-write success, hook creation/overwrite denial, metadata rename/removal denial, and ungranted-sibling denial; add a denied-read control alongside the writable-root grant.
- Land the bounded process lint and injected-result regressions in `we:scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs`.
- Land the manual workflow and its contract tests in `we:scripts/operations/__tests__/codex-sandbox-proof-workflow.test.mjs` as one prevention change. Do not broaden production permissions to make a probe pass.

## Test plan

- **Provider pairing:** `we:scripts/lib/isolation-provider.mjs` → existing `we:scripts/lib/__tests__/isolation-provider.test.mjs`; confirm omitted/empty writable roots and deny/write argument construction remain unchanged.
- **Fixture pairing:** planned `we:scripts/operations/__tests__/helpers/codex-sandbox-fixture.mjs` → planned `we:scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs` plus existing `we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs`. Inject ENOENT, timeout, signal, null status, nonzero setup exit, successful control and genuine nonzero denial. Assert diagnostics and cleanup; include path-quoting cases. The guard must reject an unchecked raw spawn mutation and accept the checked helper. Run clone topology checks without needing Codex.
- **Workflow pairing:** planned `we:.github/workflows/codex-sandbox-proof.yml` → planned `we:scripts/operations/__tests__/codex-sandbox-proof-workflow.test.mjs`. Parse YAML and assert manual-only trigger, macOS runner, exact version installation, both opt-in variables, targeted suite invocation, failure propagation, evidence upload and rejection of skipped/missing live results. Mutating away either opt-in variable must fail this test.
- **Live proof:** each negative attempt must first pass process-health checks, then prove the intended mutation did not occur. Snapshot hook contents and metadata identity before/after; a nonzero command alone is insufficient. Run the positive write control in the same fixture and profile. The default suite remains opt-in, but explicitly requested live runs cannot silently skip.

## Proof plan

1. Before the fix, demonstrate that the injected null-status/launch-error regression rejects the current negative-assertion pattern, and that the new syntax guard rejects current unchecked Git initialization. These provide deterministic red-to-green evidence independent of CLI availability.
2. After implementation, run targeted Vitest tests for `we:scripts/lib/__tests__/isolation-provider.test.mjs`, `we:scripts/operations/__tests__/codex-delivery-provider-sandbox-guards.test.mjs`, and `we:scripts/operations/__tests__/codex-sandbox-proof-workflow.test.mjs`; run `npm run check:standards`.
3. Run the live suite at `we:scripts/operations/__tests__/codex-delivery-provider-sandbox.test.mjs` with `WE_TEST_SANDBOX=0 WE_CODEX_SANDBOX_TEST=1`, then dispatch `we:.github/workflows/codex-sandbox-proof.yml` on the implementation ref with the exact candidate CLI version. Record run URL, tested SHA, CLI/OS versions, topology probes, case counts and unmodified metadata evidence. A skipped suite or unavailable host is unrun proof, never success.
4. Review the final JSDoc against that evidence. Describe only the topology and CLI/host combination actually exercised; an unexpected metadata write is a failed proof to investigate, not permission to weaken the assertion or generalize the claim.

## Done when

- **Must:** reviewers can read the complete `writableRoots` rationale before the separate measured-limit paragraph.
- **Must:** executable guard tests fail on unchecked launches and launch-error-as-denial mutations, and pass with the checked helper.
- **Must:** production-shaped clone fixtures prove allowed ordinary writes and denied metadata/sibling mutation with healthy processes and filesystem observations.
- **Must:** an explicitly requested manual CI run executes all live cases and retains CLI/host evidence; missing tooling and skipped cases fail the requested proof.
- **Must:** source, docs, config and data permissions are unchanged; this item changes proof quality, not refusal policy.

## Follow-ups

- Linked-worktree and symlink-alias sandbox behavior remain explicitly unproven and outside the current clone-based production scope. Revisit if a supported production topology adopts them.
- Re-run the opt-in workflow for each proposed CLI upgrade; update measured-limit prose only from the retained run evidence.
- A repository-wide subprocess lint would require a separate inventory of asynchronous and synchronous process APIs and their legitimate failure contracts. The bounded guard here closes the observed proof-suite defect without claiming that broader coverage.
