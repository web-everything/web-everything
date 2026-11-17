---
bornAs: xq3glrq
kind: story
size: 3
status: open
scope: ["we:scripts/lib/forge-bundle.mjs"]
dateOpened: "2026-11-14"
tags: []
---

# Forge bundle scan covers old commits from the runner base, forcing Mac runs although main is clean

The Forge bundle scan covers every commit from merge-base(head, runnerBase) to head, so old token-literal commits (e.g. 48fdc998f2 from #6719) keep forcing Mac runs. Advance the Forge runner base to current main on each sync, or scan only the net diff tree when intermediate commits are not on main. Owed 2026-11-14 11:29 ET.

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
