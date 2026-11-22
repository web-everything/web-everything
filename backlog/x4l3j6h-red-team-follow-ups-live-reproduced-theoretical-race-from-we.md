---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/codex-usage-ledger.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7341 (head a30856f5d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7341 (reviewed head `a30856f5d257443e82135fdcccb518908064b1de`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/codex-usage-ledger.mjs:66` — (edge-case, degraded) Tail-boundary discard replaces exhausted Codex quota with an older low reading
   - Scenario: Create a valid JSONL rollout larger than 262144 bytes whose newest quota event starts exactly at fileSize minus 262144, immediately after a newline. Give that event timestamp 2026-11-22T12:00:00Z, used_percent 100, window_minutes 10080 and a future reset; fill the remaining tail with a valid response_item record. Include another eligible rollout containing an 11:00 quota event reporting 1%. The unconditional lines.shift() discards the complete 100% event. The reader returns the older 1% reading, and capacity scoring labels Codex normal with score 0.89. It should preserve the complete boundary
   - Class: live-reproduced (basis: Executed the actual readCodexQuota and capacity-scoring functions with an in-memory filesystem adapter. Verified every input line was valid JSON and the complete exhausted event began at the tail boundary; observed the older 1% reading returned and scored as available. No concurrent mutation or attacker is required.)
   - Also class: theoretical-race
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
