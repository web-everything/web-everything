---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7494 (head 73ea618f7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7494 (reviewed head `73ea618f7989dad3362882dd8bdcad9366f8b09c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:772` — (edge-case, degraded) Shadow logging suppresses rejected chains, hiding ID/time disagreements
   - Scenario: Use default maxFailures 1 with two GitHub Actions checks for the same commit, name and run: job 21 fails before removal, then job 11 starts later and succeeds. The validator probe confirms the default result, while maxFailures 3 rejects the descending job ID and returns no failures field. Consequently, !at3.failures returns an empty shadow string. Expected: emit actual=confirmed at3=hold so operators can observe this explicitly identified risk before raising the setting.
   - Class: live-reproduced (basis: A read-only Node probe reproduced default confirmation, rejection at 3, and the empty result from the production shadow condition. The full guard probe was unavailable because markdown-it is missing.)
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
