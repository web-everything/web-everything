---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7572 (head 43f2f4fb8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7572 (reviewed head `43f2f4fb8cda67ce23b13565c3374db684c33766`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/readiness/heavy-admission.mjs:1360` — (failing-input, degraded) The remote CLI silently overrides the new Mesa default with Forge
   - Scenario: With valid canonical preferences containing {} and Mesa ready but Forge unavailable, invoke node we:scripts/readiness/remote-exec.mjs -- npm run check:standards. parseArgs still supplies host='forge', which this selection treats as an explicit override. Only Forge is probed, then execution falls back locally without considering Mesa. An invocation without --host should use the new mesa-01 default; only an explicitly supplied host should override it.
   - Class: live-reproduced (basis: Executed the production parseArgs-to-main routing path with filesystem writes stubbed in memory and injected readiness results of 0 for Mesa and 255 for Forge. Observed exactly one probe targeting Forge and one local fallback call; Mesa was never probed.)
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
