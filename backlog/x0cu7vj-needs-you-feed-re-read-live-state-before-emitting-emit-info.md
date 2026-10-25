---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Needs-you feed: re-read live state before emitting, emit info kinds for cleared holds, alert on conflicting standing rulings

2026-10-23: (a) 18:45 ET the feed emitted #5530 'at-round-limit: review parked with confirmed findings' one minute AFTER the reviewer accepted the same head (labels review:accepted, red-team:clear, ready-to-merge) - re-read live labels and verdict for the head before emitting; (b) 19:12 ET a 'referral hold auto-resolved, every finding ruled, no ruling needed' message was emitted as kind=ruling-needed (#5806) - emit an info/cleared kind; (c) 18:35 ET with conflicting standing rulings (not-real vs block) the review pauses silently on #5806 - emit needs-you at once and apply a deterministic precedence (latest operator ruling on the head wins, else newest).

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
