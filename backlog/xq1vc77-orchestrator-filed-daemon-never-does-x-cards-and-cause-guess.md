---
kind: story
size: 2
status: open
scope: ["we:cards-to-file.md"]
dateOpened: "2026-11-02"
tags: []
---

# Orchestrator-filed "daemon never does X" cards and cause guesses go out without a trace line, and two were wro

MED priority hint. 393. (coroner-1031, held, MED) Orchestrator-filed "daemon never does X" cards and cause guesses go out without a trace line, and two were wrong the same day. 19:47 ET HIGH card "fix daemon never ci-heals a draft" was retracted at 19:58 ET (the reconcile tick did dispatch ci-heal for #6141 at 21:11Z and 23:55Z; the "skip" line was the promotion loop). The "VS Code watchers cause the load" guess was wrong (the 20:08 git trace shows 1028 fetch and 2057 status runs from our own lanes and daemons in 15 min). At 07:43/07:45 ET two HIGH cards said "background Bash breaks the pinned rule"; 08:09 ET proved a harness-backgrounded subagent Bash does wake the subagent, so both needed a rewrite. Cost: 3 cards, about 25 min of operator attention, no worker rounds.     Fix idea: the card-append and file-item paths refuse a HIGH card whose claim contains never/always/silently unless it carries one evidence line (a log excerpt or `pr-trace` output showing the dispatch or its absence); the coroner counts retractions per night.     Evidence: we:cards-to-file.md 19:47 and 19:58 ET entries; 07:43, 07:45,

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
