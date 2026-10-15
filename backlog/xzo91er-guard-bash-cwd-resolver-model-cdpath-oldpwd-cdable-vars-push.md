---
kind: story
size: 5
status: active
scaffoldedBy: "fix-5403"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# guard-bash cwd resolver: model CDPATH, OLDPWD, cdable_vars, pushd, eval and conditional or subshell cd statements

Found by the PR 5403 self-review. resolveEffectiveCwd (the static first-cd walk) still differs from bash in structural ways the PR did not change: a set or prefix CDPATH, OLDPWD with cd -, shopt cdable_vars, pushd, eval cd, cd inside if/then, while/do, a subshell, a pipe, a background job or a function body, assignments after then/do, top-level local (errors and keeps the value), ANSI-C quoted command names or escaped dollar-quote targets, and -e/-@ options that bash 3.2 rejects but bash 5 accepts. Each can resolve to the reported cwd while bash enters a protected daemon clone, or the reverse. Decide per case: model it, or deny the command as unresolvable when a protected path is reachable.

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
