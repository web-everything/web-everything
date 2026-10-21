---
bornAs: x5qhfkd
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-saved-red-team.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5551 (head e06e32a0a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5551 (reviewed head `e06e32a0a60029096637651ffa481074eb70c957`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-saved-red-team.mjs:46` — (failing-input, degraded) Publishing a saved result later changes its identity and duplicates gate actions
   - Scenario: Save a completed confirmed degraded finding whose summary is 'two writers race' with two spaces, and let its advisory-comment publication fail. The gate files its follow-up using the saved result. On retry, renderRedTeamComment collapses the summary to 'two writers race'. When that advisory comment posts, the gate prefers it, computes a different resultId, and files the same follow-up again. A Node probe using the production renderer and gate returned 'applied' twice and queued two cards. Saved and posted representations of the same pass should share a canonical identity and retain prior gate
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
