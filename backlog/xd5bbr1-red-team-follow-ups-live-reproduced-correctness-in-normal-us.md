---
kind: story
size: 2
status: open
scope: ["we:scripts/hot-patch.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7227 (head 22aee9c6b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7227 (reviewed head `22aee9c6bd942f38b7f74d965162906207693ea8`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/hot-patch.mjs:28` — (failing-input, degraded) Timestamp-prefixed reasons crash hot-patch status
   - Scenario: Record a hot-patch load using the valid urgent reason '2026-11-21T13:00:00Z: repair review loop', then run hot-patch status. easternTimes treats the free-text reason as a timestamp, causing status to return 1 with 'Invalid time value' and no output. Timestamp conversion should target timestamp fields and preserve arbitrary reason text.
   - Class: live-reproduced (basis: Invoked the repository's main(['status']) with the described load through its injected ledger reader. Observed code:1, empty stdout, and stderr:'Invalid time value'. No files were written; the unused YAML dependency was stubbed.)
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
