---
kind: story
size: 3
status: active
scaffoldedBy: "fix-4791"
dateScaffolded: "2026-10-10"
scope: ["we:scripts/pr-land.mjs", "we:scripts/lib/pr-limit.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# pr-limit allow: check the grant's session at land time, not only the caller's cwd

Self-review of PR 4791 found the own-branch refusal in authoriseAllow keys on the caller's cwd and git config, which an agent controls: allow run from a dir outside any checkout, from a detached HEAD, or with pr-land pushing --ref=lane/x from a differently named local branch sees no own name, so the grant passes. allowBranch already records the granting session; pr-land's isBranchAllowedLive(REF) should refuse an entry whose session equals the pr-land caller's currentActorId. cwd-independent; closes the REF-differs-from-local-branch variant.

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
