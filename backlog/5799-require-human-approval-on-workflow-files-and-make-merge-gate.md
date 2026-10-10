---
bornAs: xha9nns
kind: story
size: 3
status: open
scope: ["we:.github/CODEOWNERS", "we:scripts/lib/gate-config.mjs", "we:scripts/lib/__tests__/gate-config.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Require human approval on workflow files and make merge-gate and review-gate workflow edits human-required

PR 4708 review: the YAML of we:.github/workflows/merge-gate.yml is read from the PR merge ref (pull_request) and the group commit (merge_group), so a PR can edit it to exit 0 and the required check goes green. Today only the agent-reviewable blast-radius escalation guards it. Same pattern in we:.github/workflows/review-gate.yml. Add a CODEOWNERS or ruleset rule requiring human approval on workflow files, and/or make a diff touching those two workflows always human-required via the trust-chain paths in we:scripts/lib/gate-config.mjs (a human-ratified statute change).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/gate-config.test.mjs` includes a test that `scoreEscalation` on a diff touching we:.github/workflows/merge-gate.yml or we:.github/workflows/review-gate.yml returns `humanRequired: true`; it fails before this item and passes after.

## Non-goals

- [N1] Does not make every workflow edit human-required, and does not change the agent-review path for other files.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — path matching is on normalized repo paths, so a renamed or `..`-laden path cannot dodge the rule.
2. **Truncated reads** — n/a: the rule reads the changed-file list the escalation already uses.
3. **Shared state files** — n/a: no state files.
4. **Fail closed** — an unreadable changed-file list stays escalated, as today.
5. **Identity scoping** — the approval must come from a human code owner, not the PR author.
6. **State over time** — n/a: the rule is stateless per diff.
7. **Who wrote it** — an agent-authored edit is human-required exactly like a human-authored one.
