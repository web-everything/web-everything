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

Residuals from PR 6262 (R451), same family as 7625. Replace we:scripts/guard-bash.mjs shell-state tracking (assignments, declare, conditionals, eval, wrappers, tilde) with an allowlist: any git invocation whose target dir or refspec cannot be resolved statically, while a daemon clone is registered, is denied unless provably a lane clone. PR 6262 already handles persisted remote.*.fetch config and git config / git remote mutation (class G). Its operator send-back repair adds a separate daemon-command read classification, unknown-global-option refusal, wrapper directory checks and compound-export coverage. Replacing the underlying shell-state tracker remains this card's broader work; the delivered protections are not residual gaps.

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

## Audit finding carried from PR 6262 (R451)

The final audit found one origin/main deny that HEAD no longer denies: `git branch -C <name> <copy>` read as a `-C <dir>` target on main (a false positive, since `branch -C` copies a branch). The new parser stops reading `-C` at the subcommand. No protected-clone write bypass was shown. Decide in the allowlist redesign whether to restore a deny for this shape.
