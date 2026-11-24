---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/resource-pool.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7385 (head dcc27ab33)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7385 (reviewed head `dcc27ab33c745134bf13adf88bd99cc2d1ed0578`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/resource-pool.mjs:21` — (edge-case, degraded) Text CLI output omits all shadow comparison rows
   - Scenario: Supply a healthy report with zero budget and no holders: its comparison rows contain poolDecision='hold', legacyDecision='grant', and reason='builder floor'. finishResourcePool logs those rows but replaces text output with renderResourcePool, which never renders report.rows. The command succeeds without showing any decisions or disagreement. The promised text readout should include each kind's pool decision, legacy decision, and reason.
   - Class: live-reproduced (basis: Reproduced through the real finishResourcePool and renderer using a collector report with injected healthy readers and legacy admission. All three comparison rows existed, but text output contained neither decision nor reason.)
   - Also class: coverage-or-style
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
