---
kind: story
size: 8
parent: "7625"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# guard-bash: replace shell-state tracking with an allowlist that fails closed on unresolved git targets

Residuals from PR 6262 (R451), same family as 7625. Replace we:scripts/guard-bash.mjs shell-state tracking (assignments, declare, conditionals, eval, wrappers, tilde) with an allowlist: any git invocation whose target dir or refspec cannot be resolved statically, while a daemon clone is registered, is denied unless provably a lane clone. Also cover persisted remote.*.fetch config and git config / git remote mutation (class G). 6262 ships only interim fail-closed handling for tilde/HOME, declare/local, SPEC refspec expansion and bundled short flags.

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
