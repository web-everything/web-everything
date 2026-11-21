---
kind: task
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Canary PRs should self-close when their diff empties

#7242 canary PR stayed open after its diff emptied. A canary PR should close itself when the diff becomes empty. Source: build-queue 22:11 ET 2026-11-20.

## Acceptance

- [A1] **Executable** — Planned `closes canary when its real diff becomes empty` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Use a real repository fixture whose canary diff empties; assert exactly one close request.
- [A2] **Executable** — Planned `keeps nonempty canaries and ordinary PRs open` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Parameterize a nonempty canary and an ordinary PR with an empty diff; assert neither is closed.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No automatic closure of ordinary PRs.

## Edge cases this change must handle

1. **Untrusted text** — PR metadata is data.
2. **Truncated reads** — Incomplete diff reads cannot establish emptiness.
3. **Shared state files** — n/a: no new shared state file is required.
4. **Fail closed** — Diff-read failures leave the PR open with a visible reason.
5. **Identity scoping** — Close only the identified canary PR.
6. **State over time** — Recheck emptiness at closure and tolerate an already-closed canary.
7. **Who wrote it** — Verify canary identity before closing.

## Duplicate admission

new card from build-queue CARD line
