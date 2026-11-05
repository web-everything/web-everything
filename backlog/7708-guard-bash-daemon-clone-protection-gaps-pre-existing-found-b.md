---
bornAs: x7pllde
kind: story
size: 2
status: open
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# guard-bash daemon-clone protection gaps (pre-existing, found by registry PR audit)

HIGH priority hint. - (HIGH, 11-02 12:12 ET) guard-bash daemon-clone protection gaps (pre-existing, found by registry PR audit): (1) we:scripts/guard-bash.mjs:1980 checks only the FIRST `-C`, so `git -C /ws -C wev-a placeholder-named file reset --hard` passes; (2) :2037 allows `fetch --update-head-ok origin main:main` into a daemon clone. Fix: resolve the effective cwd from ALL -C/--git-dir/--work-tree args; deny --update-head-ok refspecs into daemon clones.

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
