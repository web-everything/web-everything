---
bornAs: xw51scb
kind: story
size: 5
parent: "7518"
status: resolved
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/forge-exec-manifest.mjs", "we:scripts/readiness/__tests__/"]
dateOpened: "2026-10-31"
dateResolved: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "2ee4dcbf9bf17c1674e7948339d0b15c164151b6"
tags: []
---

# Forge remote-exec: bind git to cwd and verify manifest against a filesystem walk

Stacks on PR #6059 (branch lane/forge-remote-exec-s2) and must land after it. The remote-exec manifest trusts git (GIT_DIR/GIT_WORK_TREE and other GIT_* env are obeyed, ignore rules can hide test files). Bind every git call to the cwd and cross-check the manifest against a git-free filesystem walk, failing closed to the full scan on any mismatch. Core: we:scripts/readiness/remote-exec.mjs.

## Design

Source: 6100 non-convergence design (split: PR 6059 lands as is, this card stacks on it, PR 6100 closes, a fresh delta-reuse PR follows). PR 6100 diverged from PR 6059 (15 ahead, 13 behind, merge base ac32a789), so landing it would undo PR 6059's fixes. Break 3 (GIT_DIR/GIT_WORK_TREE obeyed) also exists on PR 6059: defaultExec and createGitBlobReader pass the full env. Card 7518 marked fail-closed n/a, which was a spec gap.

In we:scripts/readiness/remote-exec.mjs:

1. [D1] bindGit({cwd, env}) covers every git call (buildManifest, buildDeltaManifest, selectBase, both rev-parse HEAD calls, createGitBlobReader, digestDeltaInput, checkSibling). It strips all GIT_* env (including GIT_CONFIG_*, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY), resolves the toplevel and absolute git dir once, requires realpath(toplevel) equal to realpath(cwd) or refuses with `unbound-worktree`, and prefixes every call with --git-dir, --work-tree and -c core.fsmonitor=false. exec takes an env param; test execs go through the binding.
2. [D2] After the manifest is built, a git-free filesystem walk (skipping node_modules and .git) fails closed to fallback(), never not-started, when: (a) a test file in the walk is not shipped (`unshipped-test-file`); (b) a symlink other than we:.claude/agent-memory exists, the link fails verifyMemoryLink, or an we:agent-memory-src file lacks a projection (`unshipped-symlink`); (c) a manifest entry is missing or has a type or dev/ino mismatch (`manifest-worktree-mismatch`); (d) a tracked path is missing from the walk and is not a deletion. Cost about 0.2s.
3. [D3] File-time fidelity: staged files keep their source mtime at full (nanosecond, statSync bigint mtimeNs) precision, and the walk check fails closed to fallback(), never not-started, on any mtime mismatch (`manifest-worktree-mismatch`).

## MVP

All three Design requirements are mandatory: D1 ships in this MVP; D2 ships in this MVP; D3 ships in this MVP. The parity tests below also ship. Nothing beyond those requirements ships in this card.

## Test plan (16-row matrix)

New file we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs, table-driven. An oracle (pure filesystem walk plus sha256) is compared with the full manifest and the delta manifest. Rows:

1. clean tree
2. same-size edit with mtime restored
3. GIT_DIR/GIT_WORK_TREE twin
4. stale GIT_INDEX_FILE
5. GIT_CONFIG_PARAMETERS with checkstat=minimal
6. scripts/build/ in info/exclude with a lost test
7. ignored test file in dist/
8. nested .gitignore hiding a test
9. GIT_CONFIG_GLOBAL excludesFile
10. 201-char we:MEMORY.md line with bridge
11. extra untracked symlink
12. bridge turned into a directory
13. fsmonitor hook
14. filter= attribute
15. deleted tracked file
16. D3 file-time fidelity: coverage report older than its source by < 1 ms must stay stale after staging (red-team result abdcb020387f660a, PR #6059, we:scripts/readiness/remote-exec.mjs:724 passes a ms-truncated Date to utimes). This row comprises all three planned cases in the guarantee-to-test matrix below; run each through both full and delta manifest paths.

All cases below are planned in we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs; they are implementation deliverables, not existing passing tests.

| Requirement / guarantee | Planned case | Observable assertion |
| --- | --- | --- |
| D3: staging preserves exact nanoseconds | `preserves_source_mtime_ns_during_staging` | Use a source fixture whose observed `statSync(source, {bigint: true}).mtimeNs` ends in `123456789n` modulo `1000000000n`; assert that fixture precondition so microsecond or millisecond rounding cannot pass. After staging, assert strict bigint equality of `statSync(staged, {bigint: true}).mtimeNs` and the captured source `mtimeNs`, without Date or Number conversion or tolerance. |
| D3: every walk mtime mismatch fails closed | `falls_back_on_walk_mtime_mismatch` | After manifest capture and before the walk, change only a file's mtime, retaining its bytes, size, type, dev and ino; assert that the observed bigint `mtimeNs` changed. Exercise earlier and later mtimes, including a 1 ns difference. Assert `fallback()` with `manifest-worktree-mismatch`, never not-started or manifest acceptance. |
| D3: sub-millisecond stale reports remain stale | `keeps_sub_ms_coverage_report_stale_after_staging` | Stage a report older than its source by a positive interval below 1 ms; assert the report is still rejected as stale after staging. |

## Proof plan

Red first on the PR 6059 head (rows 3, 4, 9). Mutations must each turn the named rows red: drop the env scrub (3, 4, 5, 9); drop the prefix (3); drop check (a) (6, 8); drop check (b) (10, 11, 12); drop check (c) (3 on delta). Row 16 mutations: truncate staging mtimes to milliseconds → `preserves_source_mtime_ns_during_staging` fails exact bigint equality; omit the walk's mtime comparison → `falls_back_on_walk_mtime_mismatch` fails its fallback assertion. Exercise both mutations on full and delta paths. These mutation checks are planned, not results claimed by this preparation card. Then run the forge-fast-manifest, forge-offload and remote-exec suites on Forge, and a live ship with GIT_DIR exported must fall back.

## Follow-ups from the design

Cards: 7532 (GIT_DIR inventory/HEAD gap on PR 6059, closed by this card), 7529 (base-guard wait concurrency), 7530 (pin-creation guard-coverage test), 7528 (exact sibling byte accounting), 7527 (manifestWire tracked default false), 7531 (stale check-ignore stubs), 7534 (fresh delta-reuse PR re-cut after PR 6100 closes).

PR #6126 prevention requests, recorded here for separate preparation tooling work outside this MVP:
- Require stable requirement IDs and a deterministic card check rejecting any mandatory Design requirement without an explicit MVP disposition.
- Require a structured guarantee-to-test matrix, and reject preparation cards when any mandatory guarantee lacks a repository-qualified test file, named planned case, or observable assertion.

## Ordering

Stacks on PR 6059 (branch lane/forge-remote-exec-s2); must land after it.

## Progress

- 2026-10-31: operator ruling R285 ("A", 2026-10-31 08:39 ET) added the file-time fidelity requirement (Design step 3) and matrix row 16.
- 2026-10-31: PR #6126 review repair gives D1–D3 explicit MVP dispositions and expands row 16 with named planned cases and observable assertions for exact nanosecond staging, mtime-only walk fallback, and sub-millisecond report staleness.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-manifest-parity.test.mjs` (fails on the PR 6059 head, passes after this card).

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not add delta-reuse (that is 7534). Does not touch PR 6100 or PR 6059.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — GIT_* env and repo config (info/exclude, .gitignore, attributes, filter=, fsmonitor hook) are untrusted: env is stripped and config overrides are pinned.
2. **Truncated reads** — a walk or git read that errors or is cut short counts as a mismatch and falls back to the full scan.
3. **Shared state files** — memory files (we:MEMORY.md, we:agent-memory-src projections) are checked for a valid projection; a bad bridge falls back.
4. **Fail closed** — any git or walk mismatch refuses the delta path and falls back to the full scan (never not-started); a non-bound worktree refuses with unbound-worktree.
5. **Identity scoping** — realpath(toplevel) must equal realpath(cwd), so a git dir belonging to another tree is never used.
6. **State over time** — same-size edits with restored mtime are caught by hash/walk comparison; deletions are handled explicitly.
7. **Who wrote it** — n/a: the manifest does not trust file authorship.
