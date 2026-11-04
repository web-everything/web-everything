---
kind: story
size: 3
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/__tests__/lane-pool-release-unpushed-guard.test.mjs"]
dateOpened: "2026-11-04"
tags: []
---

# Release guard: detect tracked edits hidden by a hand-forged index stat cache

PR #6319 hardened the we:scripts/lane-pool.mjs release guard against index flags, submodule-ignore and stat-trust config, but a lane that rewrites .git/index with stat fields matching an edited file still reads clean, because git status trusts the index stat cache. A full content rehash closes it but cost ~108s on a 15k-file lane under load, too slow for every release. Find a bounded check (e.g. rehash only entries whose stat changed since a daemon-recorded index snapshot, or rehash on a sampled or size-bounded basis with fail-closed fallback) and wire it into releaseTrackedChanges.

## Acceptance

- [A1] **Executable** — a new case in `we:scripts/__tests__/lane-pool-release-unpushed-guard.test.mjs` edits a tracked file, then rewrites `.git/index` so the entry's stat fields match the edited file (e.g. `git update-index --refresh` under `core.checkStat=minimal` written by a lane process before release), and asserts `release` refuses with `UNPUSHED_WORK` naming the file. It fails on main and passes after.
- [A2] **Bounded** — the check's cost on a 15k-file lane stays within a stated budget (documented in the test or the code), and exceeding it refuses with the `--discard` fallback named, never a silent pass.

## Non-goals

- [N1] Untracked files stay out of scope, as the guard documents; this card only covers tracked content the index stat cache can hide.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — paths from `ls-files -z` may hold newlines or tabs; parse NUL-delimited records and print paths through the existing control-character scrub.
2. **Truncated reads** — an unreadable or oversized hash/ls-files output returns null evidence, which refuses.
3. **Shared state files** — any daemon-recorded index snapshot is written atomically (temp + rename) and read under the lane lease; a missing or torn snapshot means "rehash", not "clean".
4. **Fail closed** — any budget overrun, hash failure or count mismatch refuses release and names `--discard`.
5. **Identity scoping** — a snapshot is keyed to the exact lane and lease holder; another lease's snapshot is never trusted.
6. **State over time** — a snapshot older than the lease's acquire time is ignored.
7. **Who wrote it** — the lane process can write `.git/index` and anything under `.git/`, so no lane-writable file is trusted as the baseline; the baseline lives outside the lane.
