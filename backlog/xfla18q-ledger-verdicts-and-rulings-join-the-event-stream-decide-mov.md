---
kind: story
size: 5
parent: "xf7ax93"
status: open
blockedBy: ["xwgwm0b", "xu8wvf7"]
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/pr-state.mjs", "we:scripts/conveyor/decide.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Ledger verdicts and rulings join the event stream; decide moves onto derivePrState

Ruling E3, step 5. Ledger verdicts and rulings are written into the same ordered stream as facts and runtime events, kept forever. The decide reads one PR state derived from that stream (derivePrState in we:scripts/lib/pr-state.mjs) instead of planReconcile inputs.

## Acceptance

- [A1] **Executable** — a replay test feeds one recorded stream (facts, verdicts, worker events) to the decide twice and asserts identical actions both times; it also asserts the decide reads its PR state from derivePrState, not from planReconcile inputs.
- [A2] Ledger verdicts and rulings are appended to the same ordered stream, under the same `seq`, and are never pruned.
- [A3] A verdict appended while a PR is dirty causes a re-decide of that PR.
- [A4] Measured: safety-pass finds trend to 0; total GitHub calls per 48 h reported against the 2026-10-08 baseline (312k).

## Non-goals

- [N1] No change to the ledger event schema itself (that is the ledger standard work under #5407).
- [N2] Ledger store adapters stay as they are; this slice only routes the events into the one stream.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — verdict text is data; only the verdict kind and its keys drive decide.
2. **Truncated reads** — a cut-off ledger read is unreadable, never empty.
3. **Shared state files** — the stream has one `seq` writer.
4. **Fail closed** — if the ledger part of a PR state is unreadable, decide holds the PR and requests no land.
5. **Identity scoping** — verdicts are keyed to repo, PR and head commit.
6. **State over time** — judgments are kept forever; old rows are never rewritten.
7. **Who wrote it** — every verdict and ruling records its writer.
