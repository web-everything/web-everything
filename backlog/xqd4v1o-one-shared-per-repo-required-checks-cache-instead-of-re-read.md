---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/required-checks-cache.mjs", "we:scripts/conveyor/await-verify-loop.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# One shared per-repo required-checks cache instead of re-reading branch protection on every check

Held finding 226 (coroner-5). repos/.../branches/main/protection was read 5,470 times in 12 h (await-verify-loop 3,807, ci-red-recovery-watch 501, reconcile-pass 445, reconcile-fix 355, review-daemon 293); still 322/h after the 18:30 ET fix, though the required list changes a few times a week. Since #4924 the reader goes to rulesets first; same issue. Fix: one per-repo cache file (TTL setting default 15 min, ETag so revalidation is a free 304), invalidated by a ruleset/branch_protection event from the pr-events feed; every reader goes through it.

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
