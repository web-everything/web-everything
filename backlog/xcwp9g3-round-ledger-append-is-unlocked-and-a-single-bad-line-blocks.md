---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/round-ledger.mjs", "we:scripts/conveyor/round-judge-shadow.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# round-ledger append is unlocked and a single bad line blocks all appends

Flow-sim gap C-G8, class K4 (poison record halts a whole pass). Failing input: round-ledger.jsonl exists. (a) two writers append for the same PR concurrently, or (b) a writer died mid appendFileSync leaving a torn last line, or (c) file unreadable with a code other than ENOENT.' 'E21 / E24 / E27 Cited: we:scripts/lib/round-ledger.mjs:40, we:scripts/conveyor/round-judge-shadow.mjs:190. Soak-break sketch: none

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
