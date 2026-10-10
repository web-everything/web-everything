---
bornAs: xg0rkxn
kind: story
size: 2
priority: high
status: resolved
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/load-flake-merge-main.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# A load-flake retry merges current main into the PR head first

Live plateau #220 (2026-10-10): the quiet-host re-dispatch ran on old head 4687407aa without the just-merged timing-test fix #221 and went red on the same flakes. Before a load-flake retry, merge current main into the PR branch when main moved past the head (sanctioned merge commit, plain fast-forward push, no force); a conflict is left to the normal conflict-fix path. Setting loadFlake.mergeMainBeforeRetry (default true), policy-cascade shape, source logged. Retry-count reset half already shipped in PR #4758.

## Acceptance

- [A1] **Executable** — `npm run test:unit` on we:scripts/conveyor/__tests__/load-flake-merge-main.test.mjs — the #220-shaped re-dispatch calls mergeMain before posting `redispatched`, and the real-git case pushes a two-parent merge commit as a fast-forward.


## Non-goals

- [N1] The saved-alt-fix path (WE only) is unchanged: its contract is to verify and push the exact recorded alt sha, and a merged head would no longer match the re-arm check. The retry-count reset is PR #4758's.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the merge note is built from git shas and file names; comment builders already cut detail.
2. **Truncated reads** — the PR thread is read through the complete comment reader the pass already uses.
3. **Shared state files** — n/a: the merge runs in the daemon checkout with plumbing only (no working tree, no index, no ref writes).
4. **Fail closed** — a fetch or push failure throws; the hold stays live and the next sweep retries. A conflict pushes nothing.
5. **Identity scoping** — the push targets only the PR's own head branch, as a plain fast-forward (no force); a moved head is refused.
6. **State over time** — main is compared at retry time (main not an ancestor of the head), not at hold time — live #220's fix landed before the hold.
7. **Who wrote it** — the merge commit uses the daemon checkout's own git identity; hooks are off (core.hooksPath=/dev/null).
