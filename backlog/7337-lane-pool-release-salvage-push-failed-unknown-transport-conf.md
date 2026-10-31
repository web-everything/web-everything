---
bornAs: xtyxepf
kind: task
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-pool-salvage-push.mjs", "we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/health-watch-lane-scan.mjs"]
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
- **B. Embedded repos in snapshot.** In `snapshotWorkTree`, build the path list explicitly (`git ls-files -z -o -m -d --exclude-standard`, already what `dirtyPaths` yields), detect untracked paths that are a nested git repo (reported with a trailing `/` and containing `.git`), and exclude them from the index add. Preserve their content by writing a tar (or `git bundle` when it has commits) into the salvage dir next to the lane bundle, and record it in the salvage record (`nestedRepos: [{path, archive, sha256}]`). Salvage stays all-or-nothing: if the nested archive cannot be written, the snapshot fails and nothing is reset.
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

Each case is RED today and GREEN after.
1. `we:scripts/lib/__tests__/lane-pool-salvage-push.test.mjs`: fake `git config --show-origin --show-scope` output with `unknown` + origin `file:/Library/Developer/CommandLineTools/...` + `credential.helper` -> push proceeds (today throws `unknown transport config scope`).
2. Same file: `unknown` scope with an origin inside the lane dir, a relative origin, or no origin -> still throws `unknown transport config scope`.
3. Same file: `unknown` entry `url.x.insteadOf` -> still refused (URL rewrite).
4. `we:scripts/lib/__tests__/lane-salvage.test.mjs`: lane with an untracked nested git clone -> `snapshotWorkTree` succeeds, wip commit excludes it, record lists the archive, archive hash matches the tree (today: `fatal: adding files failed`).
5. Same: nested archive write fails (read-only salvage dir) -> snapshot throws, nothing reset.
6. `we:scripts/__tests__/lane-pool-release-salvage.test.mjs`: salvage `failed` on a dirty lane -> release exits non-success path, lane marked `quarantined: salvage-failed`, `acquire` skips it (today: warns, releases, lane reusable dirty).
7. Same: salvage failed on a clean, fully pushed lane -> released normally.
8. Same: quarantined lane + successful `reclaim --salvage` -> unquarantined, content in refs/archive.

## Proof plan

- Before: on the host, `lane-pool release` (we:scripts/lane-pool.mjs) of a lane with one uncommitted file prints `SALVAGE PUSH FAILED: unknown transport config scope`; on a throwaway copy of lane-3's `.fix-scratch` shape, `reclaim --lane=N --salvage --dry-run` then real run shows `fatal: adding files failed`.
- After: same two commands show `salvaged to refs/...` and a recorded nested archive whose sha256 matches `tar | shasum`; dirty unleased lane count (`lane-pool status`) does not grow across 5 consecutive acquire/release cycles.
- Negative proof: put `[http] proxy=...` in the lane's local config and confirm release still refuses with `lane-controlled transport configuration`.

## Follow-ups

- D: lane-pool-health-watch auto-reclaim of quiet dirty unleased lanes (salvage first), so a missed release self-heals.
- `lane-pool doctor`/status line listing quarantined lanes and why.
- Sweep other `--show-scope` consumers for the same Apple Git `unknown` scope.
- Clean up the ~70 historic dirty lanes via the same reclaim path once A and B land.
