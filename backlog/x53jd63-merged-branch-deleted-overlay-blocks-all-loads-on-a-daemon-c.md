---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Merged+branch-deleted overlay blocks ALL loads on a daemon (check-unverifiable/fetch-failed)

HIGH priority hint. - (HIGH, 11-02 08:48 ET) Merged+branch-deleted overlay blocks ALL loads on a daemon (check-unverifiable/fetch-failed): lane/referral-repo-slug-key (#6188 merged 08:30, branch deleted) blocked #31 load ×3 until hand-retired (D-R347). Retire --dry-run found nothing because the stored tip (bb232111) was older than the PR head (58e5a50b). Fix: loader auto-retires a fetch-failed registration when its PR is MERGED and the PR head is an ancestor of main; same check for every recorded tip. Extends #12/#15.

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
