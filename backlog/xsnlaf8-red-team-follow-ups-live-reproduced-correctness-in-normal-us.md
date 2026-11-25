---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/red-team-dispatch-queue.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7462 (head ff6280685)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7462 (reviewed head `ff62806853e193d8c8283066e2cf51c737485e7a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/red-team-dispatch-queue.mjs:442` — (edge-case, degraded) Failed queue persistence permanently consumes an unapplied reprobe request
   - Scenario: Persist two planner-skipped entries with probe turns 1 and 100, request the second head, and run a tick with maxProbes=0. If queue writes fail with ENOSPC but the inbox rename succeeds, commit still marks the request .done. Restart before a successful queue write: the second head retains turn 100, the first head gets the next probe, and requesting the second head again returns deduped:true. The requested priority is permanently lost. Keep the request pending until its queue mutation is durably persisted.
   - Class: live-reproduced (basis: A read-only in-memory probe executing the production queue and inbox logic reproduced this sequence with injected ENOSPC writes, successful inbox rename, and queue reconstruction from persisted state. It observed turn 100 after restart and rejection of the replacement request.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
