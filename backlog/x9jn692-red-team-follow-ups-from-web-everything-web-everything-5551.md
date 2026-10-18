---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-saved-red-team.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5551 (head 76ad28617)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5551 (reviewed head `76ad28617c559e24f83aa781d66b43f9ca5a9935`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-saved-red-team.mjs:58` — (edge-case, degraded) Saved and posted representations assign different IDs to the same finding, duplicating completed actions.
   - Scenario: Save a completed, confirmed degraded finding whose summary contains 'two writers', a newline, then 'race'. Let its advisory comment initially fail to post. Apply the gate: it files one follow-up card. Then successfully post that same finding through renderRedTeamComment and apply the gate again. The renderer collapses the newline, while the saved reader preserves it, producing different redTeamResultId values. A Node probe observed cards increase from 1 to 2, with both gate calls returning applied. Both representations should retain the same result identity and reuse the completed card action.
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
