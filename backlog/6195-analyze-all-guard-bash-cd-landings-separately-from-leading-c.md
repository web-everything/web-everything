---
bornAs: x5tbryq
kind: task
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Analyze all guard-bash cd landings separately from leading-cd home expansion

Separate follow-up to WE #5957 and PR #5403. Investigate later cd targets, nested subshell fallbacks such as ((cd /P; command) ), substitutions, conditional regions and per-command cwd. Preserve parent variables across subshell assignments and retain known values across readonly/export without operands. Require differential refusal checks against the base before replacing the single-leading-cd resolver. Any directory-set or overflow budget must have its own bounded design and tests. Scope: we:scripts/guard-bash.mjs and we:scripts/__tests__/guard-bash.test.mjs.

## Acceptance

- [A1] **Executable** — add differential cases in `we:scripts/__tests__/guard-bash.test.mjs` for later cd targets, nested subshells, substitutions and conditional bodies. Every base refusal must remain a refusal.
- [A2] Preserve parent variable values across subshell assignments and declarations without values. Test command ordering and scope before introducing state tracking.
- [A3] Document the bounded analysis and error behavior before replacing the single-directory checks in `we:scripts/guard-bash.mjs`. Cover budget exhaustion if the design needs budgets.

## Non-goals

- [N1] Reopening WE #5957 home expansion or implementing a general shell interpreter.

## Edge cases this change must handle

1. **Untrusted text** — inspect syntax without executing commands or substitutions.
2. **Truncated reads** — malformed or incomplete syntax must preserve existing refusals.
3. **Shared state files** — use isolated registry and lease fixtures; do not mutate live state.
4. **Fail closed** — unknown analysis or exhausted budgets must never bypass a base refusal.
5. **Identity scoping** — retain the existing lane ownership and daemon registry policies.
6. **State over time** — isolate parent and child shell assignments and apply changes in command order.
7. **Who wrote it** — treat every submitted command as untrusted, regardless of actor.
