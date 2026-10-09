---
bornAs: x8td06s
kind: task
status: open
scope: ["we:scripts/operations/free-scope-cli.mjs", "we:scripts/operations/free-scope.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# free-scope treats a frontmatter-only card change (priority/blockedBy) in an open PR as occupying the card, blocking real work on it

Seen 2026-10-09 on #3930: PR #4681 only added priority: high to backlog/3930-*.md, yet free-scope marked the card OCCUPIED and the worker brief stopped the build; the coordinator had to hand-pass --exclude-pr=4681 and stack the branch. Fix idea: a PR whose diff to a card touches only frontmatter keys like priority/blockedBy/relatedTo/tags does not occupy it (or such edits compose automatically, e.g. the drain rebases them). Done when: a free-scope test with a PR diff that only changes priority on a card reports the card FREE, and a body edit still reports OCCUPIED.

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
