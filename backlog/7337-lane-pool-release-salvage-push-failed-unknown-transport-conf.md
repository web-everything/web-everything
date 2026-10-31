---
bornAs: xtyxepf
kind: task
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-pool-salvage-push.mjs", "we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/health-watch-lane-scan.mjs", "we:scripts/lib/__tests__/lane-pool-salvage-push.test.mjs", "we:scripts/lib/__tests__/lane-salvage.test.mjs", "we:scripts/__tests__/lane-pool-release-salvage.test.mjs"]
dateOpened: "2026-10-28"
preparedDate: "2026-10-31"
preparedAgainstSha: "7a14a95543db88daa4fc0056846bf1b16c11cf64"
tags: []
---

# lane-pool release: SALVAGE PUSH FAILED unknown transport config scope

2026-10-28/31 ET. `lane-pool release` warned `SALVAGE PUSH FAILED: unknown transport config scope` on almost every release (lanes 4, 6, 10, 11, 13, 17, 25, 31, 53, 59, 87). Salvage was silently skipped, ~70 lanes were left dirty and unleased, and the pool starved until `lane-pool reclaim --salvage` was run by hand (09:35 ET). That same `reclaim --salvage` then failed on lane-3 with `Command failed: git add -A -- . :(exclude).claude/worktrees`.

## Root cause (reproduced, two separate bugs)

1. **Push preflight rejects Apple git's `unknown` scope.** `checkTransportConfig` (we:scripts/lib/lane-pool-salvage-push.mjs:75) allows only `system|global|local|worktree|command`. On macOS Apple Git (2.54, Xcode CLT) `git config --show-scope --list` reports the CLT file `/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig` (`credential.helper=osxkeychain`, `init.defaultbranch=main`) with scope `unknown`. That is operator-owned, not lane-controlled, so every lane on this host trips the throw. The throw is caught as a `failed` salvage and `release` carries on (we:scripts/lane-pool.mjs:2815, 2988 log a WARNING and release anyway = fail open).
2. **Snapshot cannot index an embedded repo.** `snapshotWorkTree` (we:scripts/lib/lane-salvage.mjs:412) runs `git add -A -- . :(exclude).claude/worktrees` into a throwaway index. Lane-3 holds untracked `.fix-scratch/probe-run/base-clean/`, a nested git clone. Reproduced: `error: '.fix-scratch/probe-run/base-clean/' does not have a commit checked out ... fatal: adding files failed`, so the whole snapshot (and `reclaim --salvage`) aborts and preserves nothing.

## Design

- **A. Scope `unknown` handling.** In `checkTransportConfig`, treat scope `unknown` as trusted only when the entry's origin file (`--show-origin`) is the git-owned system-style file. Concretely: switch the scoped read to `--show-origin --show-scope`, and accept `unknown` only when the origin is `file:` under an absolute path that is not inside the lane dir, its `.git` dir, or any path the lane can write (resolve realpath, compare to lane realpath). Any other unknown scope, an unknown scope from an in-lane or relative origin, or a missing origin keeps throwing `unknown transport config scope`. Keep the key deny-list (credential.*, http.*, protocol.* ...) applied to `unknown` entries exactly as for `system`/`global` (allowed, since operator-owned) but never to in-lane origins. Do not widen the `local|worktree` deny-list.
- **B. Embedded repos in snapshot.** In `snapshotWorkTree`, build the path list explicitly (`git ls-files -z -o -m -d --exclude-standard`, already what `dirtyPaths` yields), detect untracked paths that are a nested git repo (reported with a trailing `/` and containing `.git`), and exclude them from the index add. Preserve each nested repository in a self-contained tar archive of its full working tree (including modified, untracked, and ignored files) and repository metadata, stored in the salvage dir next to the lane bundle; record `nestedRepos: [{path, archive, sha256}]`, hashing the exact archive bytes. A Git bundle may supplement this archive but cannot replace it: bundles preserve committed objects, not uncommitted file bytes. Restoration must recover committed history and the exact working-tree paths and bytes, including for an unborn repository. Salvage stays all-or-nothing: if the nested archive cannot be written or verified, the snapshot fails and nothing is reset.
- **C. Fail closed on release.** When salvage returns `failed` and the lane is dirty or has unpushed commits, `release` must NOT delete the lease and report success. Instead mark the lane `quarantined: salvage-failed` (reason recorded in the lane marker and the reclaim-refusal journal, we:scripts/lane-pool.mjs:4292), still free the holder's session so the holder is done, and leave the lane unavailable to `acquire` until reclaimed. A clean lane with nothing unpushed releases as today. No code path resets, cleans, or removes a dirty lane unless salvage succeeded.
- **D. Auto-reclaim of quiet dirty unleased lanes.** `lane-pool-health-watch` (we:scripts/lib/health-watch-lane-scan.mjs) gains a pass: a lane with no lease, quarantined or dirty, quiet past `DEFAULT_SALVAGE_QUIET_MIN`, passing `laneLivenessGate`, is reclaimed through the existing `reclaim --lane=N --salvage` path (salvage first, reset only after a successful snapshot). Bounded per tick; uses the existing file lock; journals every action.

## MVP

Musts: A (scope `unknown` from a non-lane absolute origin accepted, everything else still refused), B (embedded repo no longer aborts the snapshot, its content is archived and recorded), C (release fail-closed to a quarantine marker when salvage fails on a dirty/unpushed lane).
Out of scope (Follow-ups): D auto-reclaim in health-watch, a `lane-pool doctor` that lists quarantined lanes, non-macOS git variants.

## Acceptance

- [A1] **Executable** — `node we:scripts/operations/run.mjs test --files=we:scripts/lib/__tests__/lane-pool-salvage-push.test.mjs we:scripts/__tests__/lane-pool-release-salvage.test.mjs we:scripts/lib/__tests__/lane-salvage.test.mjs` fails before this item lands (no case accepts `unknown`-scope system config, snapshot aborts on a nested repo, release drops the lease on failed salvage) and passes after.
- [A2] **Live** — on this host (Apple Git, `unknown`-scope CLT gitconfig), `lane-pool release` of a dirty lane prints `salvaged to <ref>` and no `SALVAGE PUSH FAILED`.

## Non-goals

- [N1] Not weakening salvage: content is preserved (pushed or archived) before any reset or clean, and a failed salvage never leads to a reset.
- [N2] Not trusting lane-controlled transport config: `local`/`worktree` deny-list and URL-rewrite refusal are unchanged.
- [N3] Not changing the lease/claim model beyond the new quarantine marker.

## Edge cases this change must handle

1. **Untrusted text** — config keys/origins come from NUL-delimited `git config -z` output (already used); the origin path is compared as a path, never passed to a shell or argv; nested-repo paths go to tar/bundle via argv array after `--`, a name starting with `--` is passed as `./name`.
2. **Truncated reads** — the scoped `config --list` read keeps the odd-count and missing-trailing-NUL checks (now triples with origin); `ls-files` output needs `maxBuffer` headroom and a truncated read fails the snapshot rather than snapshotting less.
3. **Shared state files** — the quarantine marker is written with the existing atomic marker writer under the lane lock (`takeMarkerIf` compare-and-set); two releases racing cannot both quarantine and drop.
4. **Fail closed** — unreadable config, unresolvable origin realpath, failed nested archive, or failed push all leave the lane quarantined, never released-clean; the reason string is journaled.
5. **Identity scoping** — quarantine marker keyed by pool + lane number + lease session; a new acquirer's lease is never overwritten (same `sameLease` check as release).
6. **State over time** — a quarantined lane persists across restarts until reclaimed; reclaim re-runs salvage idempotently (same refs, same archive hash); the CLT gitconfig changing between preflight and push is re-read at push time (check runs per transport call).
7. **Who wrote it** — `unknown` scope is trusted by the origin file's location (outside the lane realpath), not by the scope label or key name; a symlink from the lane to the CLT path resolves via realpath and is judged by its target, a lane-local include chain is refused.

## Test plan

These are **planned tests**, not implementation or executed proof. Capability cases must fail before implementation and pass after; preservation cases pin existing guarantees. Do not assume a preservation fixture is already covered merely because a guard exists.

Test-file keys (each name below is to be implemented in the indicated file):

- **T** = `we:scripts/lib/__tests__/lane-pool-salvage-push.test.mjs`.
- **S** = `we:scripts/lib/__tests__/lane-salvage.test.mjs`.
- **R** = `we:scripts/__tests__/lane-pool-release-salvage.test.mjs`.

| Guarantee | File | Planned test | Required observable assertions |
| --- | --- | --- | --- |
| Design A: Apple system-origin capability | T | `unknown_scope_absolute_operator_origin_allows_push` | Fake NUL-delimited origin/scope records with `unknown`, an absolute CLT origin, and `credential.helper`; assert push transport executes. |
| Design A: origin refusal | T | `unknown_scope_untrusted_origin_is_refused` | Parameterize in-lane, relative, missing, and non-file origins; assert `unknown transport config scope` and zero transport calls. |
| N2: URL rewrite refusal | T | `unknown_scope_url_rewrite_is_refused` | Operator-origin `unknown` entries with `url.*.insteadOf` and `url.*.pushInsteadOf` are refused; transport never executes. |
| Edge 7: realpath trust | T | `unknown_origin_uses_resolved_target` | A symlink in the lane targeting the trusted CLT file is accepted; an out-of-lane symlink targeting a lane-writable file is refused. Assert the resolved target drives the decision and transport executes only for the trusted target. |
| Edge 7: include-chain trust | T | `lane_local_include_is_refused` | Parameterize direct and chained lane-local includes (including a symlinked target) from an otherwise trusted origin; assert refusal and zero transport calls for lane-controlled transport entries. |
| N2: existing deny-lists | T | `local_and_worktree_transport_denylists_are_preserved` | Parameterize `local` and `worktree` across every existing transport deny-list key family and URL rewrites; assert refusal before transport. Include benign keys as controls that allow transport. |
| Edge 2: complete config input | T | `rejects_incomplete_origin_scope_records` | Parameterize malformed origin/scope/key records, incomplete triples, and missing terminal NUL; assert refusal and no transport, never approval of a valid prefix. |
| Edge 6: validation per transport call | T | `transport_rechecks_changed_config_before_push` | Allow preflight, change config to a refused lane-controlled transport setting before push, and assert a second config read and refusal before push executes. |
| Design B: unborn nested repository | S | `snapshot_archives_unborn_nested_repo` | An untracked nested repo with no commits no longer aborts indexing; assert the WIP commit excludes it, the record lists the archive, SHA-256 matches archive bytes, and extraction recovers exact file paths/bytes. |
| Design B, N1: committed and dirty nested repository | S | `snapshot_preserves_dirty_nested_repo_with_commits` | Parameterize a standalone clone, a linked worktree with a `.git` file, and a repo with object alternates. Create committed files, modify one, and add untracked and ignored files. Make original repositories/metadata unavailable and restore to an empty directory from recorded salvage artifacts alone; assert committed ref/object and file bytes, modified bytes, untracked/ignored bytes, and original paths. Verify the recorded archive hash; a bundle-only or metadata-pointer-only implementation must fail this test. |
| Edge 1: literal nested paths | S | `archives_nested_repo_paths_literally` | Parameterize repo names beginning with `--`, spaces, tabs, newlines, quotes, backticks, and Unicode. Restore each archive and assert exact paths and bytes, with no option interpretation or shell execution. |
| Design B, N1: archive failure | S | `nested_archive_failure_aborts_snapshot` | Inject archive write/verification failure, including an unwritable salvage directory; assert failure, no successful partial salvage record, and unchanged files and refs with no reset/clean. |
| Edge 2: complete path input | S | `truncated_dirty_paths_abort_snapshot` | Simulate `ls-files` maxBuffer overflow and incomplete NUL-delimited output after valid paths; assert snapshot refusal, no successful partial snapshot/record, unchanged files/refs, and no reset/clean. |
| Design C: dirty lane quarantine | R | `failed_salvage_quarantines_dirty_lane` | Failed salvage returns non-success, writes `quarantined: salvage-failed`, and causes acquisition refusal. |
| Design C: clean but unpushed lane | R | `failed_salvage_quarantines_clean_unpushed_lane` | Failed salvage on a clean working tree with unpushed commits quarantines the lane; assert acquisition refusal and unchanged commit IDs/content. |
| Design C: complete release state matrix | R | `failed_salvage_release_state_matrix` | Parameterize dirty/clean × pushed/unpushed for both single-lane release and `release --all-pools --session=…`. Failed salvage quarantines all rows except clean + fully pushed, which releases normally; assert acquisition exclusion/availability and unchanged content/refs for each row. Update the existing `warns and still releases across pools when salvage is refused` test's unpushed fixture to require quarantine. |
| Design C, N1, edges 4–5: failure contract | R | `release_failure_preserves_content_and_finalizes_holder` | Parameterize config-read, origin-realpath, archive, and push failure on dirty and clean-unpushed lanes. Assert unchanged files (including untracked/nested bytes) and original refs, no reset/clean, quarantine with matching marker/journal reason, freed holder session, and acquisition refusal. |
| Edge 3: atomic transition | R | `concurrent_release_preserves_quarantine` | Use deterministic barriers for overlapping releases of the same lease with failed salvage; assert final marker retains pool/lane/session identity and quarantine reason, holder session is freed, and acquisition is excluded. |
| Edge 5, N3: stale lease transition | R | `stale_release_preserves_new_session_lease` | Pause an old release, replace the lease with a new session, then resume it. Assert the new marker/session identity is unchanged, its holder remains active, and a third acquisition is excluded. |
| Design C: successful recovery | R | `successful_reclaim_clears_quarantine_after_salvage` | Start quarantined; successful reclaim preserves content in refs/archive before reset/clean and clears quarantine only after success. Assert subsequent acquisition succeeds and restoration recovers the content. |
| Edge 6: durable quarantine | R | `quarantine_survives_process_restart` | Fail release, terminate the process, and start a fresh pool process reading persisted state; assert the same quarantine identity/reason and acquisition refusal until successful reclaim. |
| Edge 6: retry identity | R | `reclaim_retry_preserves_refs_and_archive_hash` | Interrupt reclaim after durable salvage artifacts/record but before quarantine clearance, then retry with unchanged content. Assert identical recorded salvage ref names/targets and archive SHA-256 across retries, recoverable bytes, and clearance only after successful recovery. |
| A2: actual Apple Git host integration | R | `apple_git_dirty_release_reports_salvage_success` | On the affected Apple Git host, use actual Git and host CLT configuration (no mocked config output) to release an isolated dirty lane. Assert observed `unknown` CLT origin, `salvaged to <ref>`, absence of `SALVAGE PUSH FAILED`, and recoverable changed bytes. Unsupported-host skips do not satisfy A2; retain the affected-host result as live proof. |

### Acceptance-to-test mapping

| Acceptance | Named planned tests | Required evidence |
| --- | --- | --- |
| A1 | All T/S/R tests above, including `unknown_scope_absolute_operator_origin_allows_push`, `snapshot_preserves_dirty_nested_repo_with_commits`, and `failed_salvage_release_state_matrix` | Diff-selected executable gate, with capability red/green and preservation assertions. |
| A2 | R: `apple_git_dirty_release_reports_salvage_success` | Actual affected-host configuration and release output, plus restored changed bytes; a mocked pass or unsupported-host skip is insufficient. |

### Prevention gates (filed with this preparation)

These gates are build requirements for this item; planned names must become executable assertions before implementation is accepted.

1. Gate nested salvage on archive round-trip restoration of a repository with both committed and uncommitted content (`snapshot_preserves_dirty_nested_repo_with_commits`).
2. Require a structured named-test mapping for every Acceptance identifier; preparation cards may identify tests as planned (mapping above).
3. Gate release on the dirty/clean × pushed/unpushed state matrix (`failed_salvage_release_state_matrix`).
4. Map every release failure-contract clause to an assertion across config-read, realpath, archive, and push failures (`release_failure_preserves_content_and_finalizes_holder`).
5. Map every transport-origin/refusal guarantee to named parameterized tests and assert transport-call counts (T rows above).
6. Gate parser changes on malformed/truncated records and simulated subprocess buffer overflow (`rejects_incomplete_origin_scope_records`, `truncated_dirty_paths_abort_snapshot`).
7. Require adversarial filenames in archive restoration fixtures (`archives_nested_repo_paths_literally`).
8. Require deterministic concurrency and stale-session interleavings for marker changes (`concurrent_release_preserves_quarantine`, `stale_release_preserves_new_session_lease`).
9. Require fresh-process and interrupted-retry assertions for persistence/idempotence (`quarantine_survives_process_restart`, `reclaim_retry_preserves_refs_and_archive_hash`).
10. Gate per-call validation on changing config between consecutive transport calls (`transport_rechecks_changed_config_before_push`).

## Proof plan

- Before: on the host, `lane-pool release` (we:scripts/lane-pool.mjs) of a lane with one uncommitted file prints `SALVAGE PUSH FAILED: unknown transport config scope`; on a throwaway copy of lane-3's `.fix-scratch` shape, `reclaim --lane=N --salvage --dry-run` then real run shows `fatal: adding files failed`.
- After: same two commands show `salvaged to refs/...`; verify the recorded SHA-256 against the archive bytes, then restore the nested repository into an empty directory and compare committed, modified, untracked, and ignored file bytes and paths. Retain the actual affected-host result of `apple_git_dirty_release_reports_salvage_success` for A2; dirty unleased lane count (`lane-pool status`) does not grow across 5 consecutive acquire/release cycles.
- Negative proof: put `[http] proxy=...` in the lane's local config and confirm release still refuses with `lane-controlled transport configuration`.

## Follow-ups

- D: lane-pool-health-watch auto-reclaim of quiet dirty unleased lanes (salvage first), so a missed release self-heals.
- `lane-pool doctor`/status line listing quarantined lanes and why.
- Sweep other `--show-scope` consumers for the same Apple Git `unknown` scope.
- Clean up the ~70 historic dirty lanes via the same reclaim path once A and B land.
