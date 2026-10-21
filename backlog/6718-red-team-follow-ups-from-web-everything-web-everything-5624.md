---
bornAs: xedjym6
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-transcript-backfill.mjs", "we:scripts/lane-pool.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5624 (head 025afcf9d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5624 (reviewed head `025afcf9dc30eb617957ca18ad1354009872537f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/lane-transcript-backfill.mjs:36` — (edge-case, degraded) A partially written transcript becomes permanently empty attribution
   - Scenario: Run the first explicit backfill while a transcript's matching assistant Edit record is missing its final closing brace. Real ripgrep returns the partial line successfully; strict scanning silently ignores its JSON parse failure and the backfill permanently caches touches:[]. A probe using in-memory filesystem writes confirmed that completing the record makes a fresh scan find the writer, while subsequent backfills still return the cached empty result. Incomplete matching records should refuse cache publication and permit retry.
   - Claude's re-check: demonstrated break
2. `we:scripts/lane-pool.mjs:4439` — (edge-case, degraded) Overloaded one-shot GC reports successful exit instead of deferral
   - Scenario: Invoke noninteractive lane-pool gc with a due lane and host load above the threshold. cmdGc logs the overload reason and returns without setting an exit code. Executing the actual command function with scheduledLaneGc and in-memory filesystem state produced exitCode 0 and zero Git invocations. A scheduler therefore sees success instead of the promised temporary deferral; overload should produce exit 75.
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
