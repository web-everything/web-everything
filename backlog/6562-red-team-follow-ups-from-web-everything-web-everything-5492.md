---
bornAs: xrmupo6
kind: story
size: 2
status: open
scope: ["we:scripts/lib/ledger-observation.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5492 (head fbb55e264)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5492 (reviewed head `fbb55e26425d3e95f023b17fee1e51212f9b154d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/ledger-observation.mjs:66` — (edge-case, degraded) An abbreviated restamp SHA triggers invalidation without a head change
   - Scenario: Record accepted(H), followed by restamped(H.slice(0,7)), then observe the unchanged full head H. This is supported input: review-set-label accepts --new-head values of 7–40 hex characters. The fold replaces its full witness with the abbreviation, and strict equality treats the next full SHA as a movement. A probe using H=150fc65e5f85d0d5329a43f4912462fa53128272 and the real carry prover emitted head-moved from 150fc65 to H, changing derivePrState from clears:true to clears:false. Resolve or recognize equivalent SHA spellings before invalidating an acceptance.
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
