---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/delivery-metrics.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5507 (head 084794a40)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5507 (reviewed head `084794a400e3d7e1075c3f03152e6475ad2e25df`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/delivery-metrics.mjs:260` — (failing-input, degraded) Malformed feed events produce trusted episode totals
   - Scenario: Set the feed contents to 'NEEDS-YOU we#1 {"at":"2026-10-16T16:00:00Z"}\n' and collect 2026-10-16. The parser returns an object, so validation accepts it despite missing repo, PR, head and kind. The snapshot reports needs-you.episodes=1 without a reason. Alternatively, a complete event with at="invalid" yields episodes=0 without a reason. Both outputs were reproduced using the checked-out function bodies and an in-memory filesystem. Invalid event schemas should make the affected source unavailable, yielding null with a reason.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/delivery-metrics.mjs:277` — (edge-case, degraded) Discarded Codex records become a false zero-session census
   - Scenario: Place one valid session_meta JSON record in sessions/2026/10/16/rollout-one.jsonl, timestamped 2026-10-16T16:00:00Z, with a 300 KiB base_instructions string. With default limits, readBounded discards the record because it exceeds the 256 KiB line limit, while returning found=true and truncated=false. collectExecutorLogs consequently returns found=true,count=0, which this collector publishes as sessions.codex=0 without a reason. This sequence was reproduced with the checked-out reader, executor collector and metrics functions using in-memory filesystem fixtures. The metric should count the star
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
