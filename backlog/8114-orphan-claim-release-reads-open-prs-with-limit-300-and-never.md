---
bornAs: xd1ko5f
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/orphan-claim-release.mjs", "we:scripts/backlog.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# orphan-claim-release reads open PRs with --limit 300 and never checks truncation, so a card named only by an …

Flow-sim gap R8a-G3, class K17 (partial page read as complete). Failing input: More than 300 open WE PRs. Card 4459 is status:active, older than 48h, no lease, no live session. Its only open PR (lane/4459-foo) is not in the 300 rows returned. orphan-claim-release --apply runs Cited: we:scripts/conveyor/orphan-claim-release.mjs:397, we:scripts/conveyor/orphan-claim-release.mjs:406, we:scripts/conveyor/orphan-claim-release.mjs:199, we:scripts/conveyor/orphan-claim-release.mjs:203-204, we:scripts/backlog.mjs. Soak-break sketch: Fixture: 300 filler open PRs plus a 301st naming card 4459, card 4459 active and 3 days old, other signals empty-but-array. Action: planOrphanRelease with openPrs = first 300 rows. Assert (fails today): card is skipped as signal-unavailable/open-pr-window-unc…

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
