---
bornAs: xlvrdub
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5492 (head fa23a3d07)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5492 (reviewed head `fa23a3d073611458be54aab64b07b156909c9705`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/verdict-ledger.mjs:967` — (edge-case, degraded) Disabling head observations prevents fresh reviews from clearing a previously superseded head.
   - Scenario: Set ledger.headMoveInvalidation=false. Append accepted(A), then accepted(B), and force-push the open PR back to A. Observation returns no transition because the setting is disabled. Append fresh accepted(A) and clear-human(A) after reviewing the live head. Both are discarded as superseded; the probe retains current=B and reports stale-acceptance with clears:false at live A. Repeating the review cannot recover it while observation remains disabled. Fresh, live-head review completion needs a way to re-establish A without treating delayed historical completions as current.
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
