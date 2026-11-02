---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/time-format*.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# UTC times leak into the assistant's messages and event lines ("Wrong time zone again, keeps creeping back", op

MED priority hint. 385. (coroner-1028, held) UTC times leak into the assistant's messages and event lines ("Wrong time zone again, keeps creeping back", operator 19:55 ET). Daemon event lines and the extractor print Z times; the operator reads them as local.     Fix idea: every operator-facing line (needs-you, watch-events, handoff writer) formats times in America/New_York through one shared helper, with a lint that rejects a raw `Z` timestamp in those emitters.     Evidence: operator turn 10-28 23:55Z; examples in this handoff (drain log 03:24Z lines quoted at 23:27 ET). Scope: we:scripts/lib/time-format*.mjs, the needs-you emitters. Size 2.

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
