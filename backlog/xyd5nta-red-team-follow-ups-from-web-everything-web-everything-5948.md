---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-merge-watch-signals.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5948 (head a9da952dc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5948 (reviewed head `a9da952dce7404e545eccc4af31747626c976377`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pass-daemons/pr-merge-watch-signals.mjs` — (edge-case, degraded) Force-pushing an old commit attributes previous-head refusal logs to the new head
   - Scenario: At 12:00, the current head is B, whose committer date is yesterday. The timeline records a force-push at 11:55; ten refusal logs from head A occur at 11:40–11:49. Running runMergeWatchSignals emits pr-looping with count:10 and saves B's delivery receipt, despite every refusal preceding B's push. Loop detection uses the committer date before reading the force-push timeline. It should exclude those previous-head logs; the premature receipt also suppresses a later genuine loop with the same reason on B.
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
