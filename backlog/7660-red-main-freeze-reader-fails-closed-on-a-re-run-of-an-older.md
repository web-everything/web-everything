---
bornAs: x3r17n6
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Red-main freeze reader fails CLOSED on a re-run of an OLDER main run (10-29 19:48 ET

HIGH priority hint. - [HIGH] Red-main freeze reader fails CLOSED on a re-run of an OLDER main run (10-29 19:48 ET: merge-gate "red-main freeze unreadable: main CI run 40970150129 is being re-run (attempt 2)" — that run is for 912b12656, but newer main 104a97076 is already green). Reader should judge the NEWEST main head; a re-run of a superseded sha must not freeze the queue. (Triggered by my rerun-failed-jobs on the flaky shard.)

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
