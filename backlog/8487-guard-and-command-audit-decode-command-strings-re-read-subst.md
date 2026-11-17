---
bornAs: xjhjjmh
kind: story
size: 3
status: active
scaffoldedBy: "fix-6461"
dateScaffolded: "2026-11-08"
scope: ["we:scripts/guard-bash.mjs", "we:scripts/operations/agent-command-audit.mjs"]
dateOpened: "2026-11-08"
tags: []
---

# Guard and command audit: decode $'…' command strings, re-read substitutions in single-quoted wrapper lines, and read flock --command before the lock file

Found by the self-review of the PR #6461 round 7 send-back, pre-existing: bash -c $'echo\nnpx vitest run a' is allowed (shellCString does not decode ANSI-C quoting); npx -c 'echo $(npx vitest run a)' is allowed (substitutions in a single-quoted wrapper line are not re-read); flock --command '…' f canonicalizes to the lock file. Not same class, also open: su -c, find -exec sh -c, script -q /dev/null cmd.

## Merged item (was xb52b90)

**Command audit: classify substitutions and $'…' strings inside a launched eval string, and options before a program subcommand (docker --config x login -p v)**



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

## Duplicate admission

same launched-string family; this one is the guard side
