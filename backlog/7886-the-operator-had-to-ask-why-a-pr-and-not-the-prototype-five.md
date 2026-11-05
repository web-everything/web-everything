---
bornAs: xpltt4m
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# The operator had to ask "why a PR and not the prototype" five times in one day (06:48, 07:08, 12:39, 14:29, 15

HIGH priority hint. 389. (coroner-1030, held, HIGH) The operator had to ask "why a PR and not the prototype" five times in one day (06:48, 07:08, 12:39, 14:29, 15:21 ET) although R228 (10-29) and R250 already say prototype first, in parallel with the PR. Each ask cost one operator turn and a plan change; the 14:29 ET one was "I asked for prototype with quickest path forward" plus "starting to be annoyed at us losing focus". The rule lives in memory and rulings only; nothing in the dispatch path checks it.     Fix idea: the worker-brief / dispatch check for any daemon, Forge or tooling change requires a "load on prototype" step that runs in parallel with the PR (or a one-line reason why not), and refuses the brief without it. The orchestrator never lets "wait for the PR to land" gate a load.     Evidence: operator turns 06:48, 07:08, 12:39, 14:29, 15:21 ET on 10-30 (session bd616854); R228, R250, memory 148/149. Scope: we:skills-src/worker-brief, we:.claude/hooks (Agent dispatch). Size 3.

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
