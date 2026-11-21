---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7248 (head b89c1792d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7248 (reviewed head `b89c1792d4f34b29e40a8c4de4411feb43fdb28f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-heal-loop.mjs:111` — (edge-case, degraded) The CI-heal child overwrites the parent daemon’s saved fix progress
   - Scenario: Start with a saved fix cursor of 100 for a watched repo, then start the daemon with ciHeal.loop=on. The child loads the same we:.conveyor/fix-pass-cursors.json as the parent. Its empty fixTick returns no nextCursor, so boundedPrTick deletes that fix cursor and saveFixPassCursors publishes the cleared state. Restarting the parent before it saves progress again makes deferred fixes resume from the beginning, losing fairness across restarts. The child should preserve unrelated phase cursors and persist only its own progress.
   - Class: live-reproduced (basis: An in-memory execution of the checked-out child and daemon source, with external dependencies stubbed and persistence captured instead of written, completed one CI-heal tick and published prCursors.fix={} from initial prCursors.fix={"repo-a":100}. Both production processes use the same default cursor path; no concurrent writes are required for this loss.)
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
