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

Found by the PR 5403 self-reviews. resolveEffectiveCwd (the static first-cd walk) still differs from bash in structural ways the PR did not change:

- a set or prefix CDPATH, OLDPWD with `cd -`, `shopt -s cdable_vars`, `set -o posix` (prefix assignments then persist), and `pushd`;
- `eval cd …`, and a `cd` inside if/then, while/do, a subshell, a pipe, a background job or a function body (the walk honours the first cd it sees as if it ran);
- assignments after then/do/else (walked as if they ran);
- top-level `local` (bash errors and keeps the value; the walk forgets it);
- ANSI-C quoted command names and escaped `$'…'` targets;
- `-e` / `-@` options, which bash 3.2 rejects but bash 5 accepts;
- `let` reading a variable whose value is itself an assigning expression;
- a cd target that does not exist (bash's cd fails and stays; the hook keeps the unresolved string when realpath fails);
- an unquoted `[…]` bracket glob in a cd word (`cd ~/[c]lone`) is resolved as a literal path; any unquoted glob metacharacter (`*`, `?`, `[`) should leave the word unresolved (PR 5403 advisory);
- a bare `cd` ends the first-cd walk, so `cd && cd <protected clone> && <mutation>` resolves to HOME; more than one cd that could run should make the walk unresolvable (PR 5403 advisory).

Each can resolve to the reported cwd while bash enters a protected daemon clone, or the reverse.

## Acceptance

- [A1] **Executable** — each listed shape has a `resolveEffectiveCwd` test in `we:scripts/__tests__/guard-bash.test.mjs` that either matches a `/bin/bash` probe, or proves the hook denies the command as unresolvable when a protected path is reachable.

## Non-goals

- [N1] Becoming a full shell interpreter: a shape the walk cannot model is denied as unresolvable, not emulated.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the command text is agent-written; every new shape is matched after quote removal, never on raw spelling alone.
2. **Truncated reads** — n/a: the walk reads one in-memory command string.
3. **Shared state files** — n/a: no state file is read or written.
4. **Fail closed** — an unmodelled shape that could reach a protected clone denies rather than falling back to the reported cwd.
5. **Identity scoping** — n/a: no identity is involved.
6. **State over time** — n/a: each command is resolved on its own.
7. **Who wrote it** — n/a: the hook judges the command, not its author.
