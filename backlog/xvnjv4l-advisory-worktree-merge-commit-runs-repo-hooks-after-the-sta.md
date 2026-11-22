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

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
