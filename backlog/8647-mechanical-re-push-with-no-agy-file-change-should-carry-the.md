---
bornAs: x3fzfes
kind: task
status: open
scope: ["we:designs/pr7134-nonconvergence-2026-11-21.md", "we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Mechanical re-push with no agy-file change should carry the last verdict

A re-push that changes no agy file should carry the previous audit verdict instead of forcing a new round (see we:designs/pr7134-nonconvergence-2026-11-21.md). Source: build-queue 00:33 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `carries verdict across mechanical repush with unchanged agy files` in `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs`: Compare two real commit heads with only mechanical changes; assert the last verdict is carried.
- [A2] **Executable** — Planned `requires review for changed or unreadable agy comparisons` in `we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs`: Parameterize changed agy bytes and a failed comparison; assert neither carries a verdict and both require review.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No carry across agy-file changes.

## Edge cases this change must handle

1. **Untrusted text** — Commit and verdict text cannot authorize carry.
2. **Truncated reads** — Incomplete changed-file evidence refuses carry.
3. **Shared state files** — Read the prior verdict without rewriting its provenance.
4. **Fail closed** — Comparison or verdict errors require review.
5. **Identity scoping** — Bind the verdict to the same PR and compared heads.
6. **State over time** — Re-evaluate after each push.
7. **Who wrote it** — Only the recorded audit verdict may carry.

## Duplicate admission

nd
