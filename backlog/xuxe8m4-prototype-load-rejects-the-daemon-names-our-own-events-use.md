---
kind: story
size: 2
status: open
scope: ["we:daemon-events.json"]
dateOpened: "2026-11-02"
tags: []
---

# prototype-load rejects the daemon names our own events use

MED priority hint. ## (held 2026-10-26 03:56 ET) prototype-load rejects the daemon names our own events use Workers keep calling prototype-load --daemon=wev-review-daemon / --daemon=code (unknown-daemon) because we:daemon-events.jsonl and the clone dirs use those names, while prototype-load wants review/drain/fix. 4+ refusals tonight. Fix: accept the clone-dir and event names as aliases (one name map), or have the events emit the loader name.

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
