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
- `eval cd …`, `bash -c "cd …"`, a process substitution `<(cd …)` and a `cd` in a pipe or a background job (these are outside the base leading-cd resolver; broader landing analysis is deferred to #x5tbryq);
- a segment led by a keyword or a `case` pattern (`then git reset --hard`, `x) cd D && …`) is not judged by the per-segment arms, whatever its cwd;
- the commands before the first cd run in the reported cwd, but the hook judges them in the effective cwd only (`git reset --hard; cd <lane>` from a daemon clone); judging the reported cwd too would deny the `cd <lane> && claim` idiom from a primary;
- assignments after then/do/else (walked as if they ran);
- top-level `local` (bash errors and keeps the value; the walk forgets it);
- ANSI-C quoted command names and escaped `$'…'` targets;
- `cd` options before the operand: `-L`, `-P` (quoted, escaped or combined) and `--` are read as the target today (`cd -P ~/clone` resolves to `<cwd>/-P`, as on main); `-e` / `-@`, which bash 3.2 rejects but bash 5 accepts;
- `let` reading a variable whose value is itself an assigning expression;
- a cd target that does not exist (bash's cd fails and stays; the hook keeps the unresolved string when realpath fails);

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
