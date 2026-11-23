---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7402 (head 03a565506)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7402 (reviewed head `03a565506101d863ed10f9275c1bef6efe9163fd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:949` — (failing-input, degraded) Timestamp prefixes let blank failed-job logs bypass the unreadable-log hold
   - Scenario: Use one commit-bound failed_checks removal, a failed test-shard (1) with valid attempt metadata and blank summaries, fresh green main, and PR CLEAN. Return the log string "2026-11-07T22:20:51.000Z \x1b[31m\x1b[0m\n", where \x1b denotes ESC. Stripping terminal escapes leaves the timestamp, so the guard requests POST actions/jobs/31/rerun instead of parking. Supply a subsequent successful attempt of that job on the same Actions run: the guard returns hold:false with rerun-green authorization. Timestamp-prefixed whitespace behaves identically. These logs contain no diagnostic content and should p
   - Class: live-reproduced (basis: Observed through a Node probe executing the actual mqSameHeadGuard and rerun implementation with injected GitHub responses. Unrelated review/quarantine dependencies were stubbed to load the dependency-incomplete checkout. No live API mutations occurred. Raw escape-only and unavailable-log controls parked correctly; the changed soak probe also passed despite this bypass.)
   - Also class: coverage-or-style
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
