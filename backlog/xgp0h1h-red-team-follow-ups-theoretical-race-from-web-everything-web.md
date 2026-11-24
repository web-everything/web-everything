---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7429 (head 7902f283a)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7429 (reviewed head `7902f283ad11fc8c453c89cecf6d062adfb622b3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/orphan-fix-round.mjs:202` — (pagination correctness, impact not stated) Closing a PR between pages silently skips an orphan while certifying the listing as complete.
   - Scenario: Start with open PRs numbered 201 through 1, newest first, with only #101 labeled review:changes. Page 1 returns #201–#102. Close #201 before page 2: offset pagination now returns #100–#1, skipping still-open #101. Page 3 returns empty, so defaultListBounced successfully returns an empty bounced list. The daemon treats that repository as completed without holding #101. An isolated probe executing the changed function reproduced this; the unchanged-list control returned #101.
   - Class: theoretical-race (basis: The omission was reproduced with an injected executor simulating one closure between REST page requests. The production failure requires that concurrent closure; no live GitHub race was observed.)
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
