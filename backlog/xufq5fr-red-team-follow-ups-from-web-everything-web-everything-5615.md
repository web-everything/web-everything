---
kind: story
size: 2
status: open
scope: ["we:scripts/settings/fix.json"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5615 (head dfdc65892)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5615 (reviewed head `dfdc65892253631ef312eefb479f424f6dcf9827`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/settings/fix.json:8` — (failing-input, degraded) Executor routing still escalates at round 3, bypassing the new threshold
   - Scenario: Use WE_FIX_EXECUTOR_FALLBACK_CHAIN=codex,claude and an ordinary, noncritical round-3 fix (attempts=2), with launchers available, codexUnproductive=0, and no takeover or ruling send-back. A read-only Node probe confirms resolveFixSettings returns threshold 4 and planRoundEscalation returns null, but chooseFixExecutor still selects Claude: we:scripts/lib/fix-slot-borrow.mjs:72 independently triggers escalation when round &gt;= 3. With the default chain, the same input selects codex-alt prematurely. Round 3 should retain the ordinary Codex rung and escalate at round 4. Changing only this setting theref
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
