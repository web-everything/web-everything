---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/advisory-merge.mjs", "we:scripts/lib/__tests__/daemon-rebuild-advisory-merge.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Advisory worktree merge commit runs repo hooks after the staged-blob check

resolveAdvisoryInWorktree in we:scripts/lib/daemon-rebuild/advisory-merge.mjs, on its commit:true path, runs git commit --no-edit under the repo's core.hooksPath. During a merge that hooks folder holds the merged, candidate-controlled hooks, and the pre-commit hook can rewrite the index after the resolver verified every staged blob. So the committed tree can differ from what was validated. Found by the PR #7322 self-review; it predates that PR. The resolve-generated op uses commit:false and is not affected.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/daemon-rebuild-advisory-merge.test.mjs`: a new case merges a candidate whose pre-commit hook rewrites an advisory path in the index. It asserts the resolver either refuses (and restores the index and files) or commits a tree whose advisory blobs equal the validated bytes. It fails on current main.

## Non-goals

- [N1] Does not change the commit:false path used by the resolve-generated operation.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the merged hook body is candidate-controlled; it must never run, or its effect must be verified afterwards.
2. **Truncated reads** — n/a: the tree check reads blob ids, not unbounded output.
3. **Shared state files** — the real index is rolled back on refusal, as the existing restore path does.
4. **Fail closed** — any post-commit tree mismatch refuses, and the commit is not left in place.
5. **Identity scoping** — n/a: no identities involved.
6. **State over time** — n/a: one merge at a time per worktree.
7. **Who wrote it** — hooks come from the merged checkout, so treat them as written by the candidate, not by us.
