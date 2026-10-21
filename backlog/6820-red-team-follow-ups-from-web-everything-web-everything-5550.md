---
bornAs: xdshjdz
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-label-mirror.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5550 (head 55c36a091)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5550 (reviewed head `55c36a091f240c527a545e12a79dc712cb7c5915`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-label-mirror.mjs:267` — (edge-case, degraded) A live session causes the mirror to clear an explicitly unruled referral
   - Scenario: Input: an open PR carrying advisory:ruling-needed, one valid current-head referral event without any ruling, readable facts, green checks, and a live review session. The lifecycle becomes IN-REVIEW, whose rendered labels omit the advisory, although derivePrState still reports referral-unruled and needsYou='rule on 1 finding(s)'. A probe through runMirrorApply requested setRulingLabel(repo,7,false) with failures=[]. Thus starting a review or fix session hides an outstanding ruling request without settling it. The advisory should remain while the finding needs a ruling, independently of session
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
