---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7238 (head 1b355339d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7238 (reviewed head `1b355339df41a8d004025bf17286a14f36084af7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-heal-loop.mjs:122` — (edge-case, cosmetic) Auth-paused ticks log authPaused=false.
   - Scenario: When planAuth returns paused=true, runCiHealTick returns only skipped='auth-paused'. runCiHealLoopIteration then logs 'refusals=0 errors=0 authPaused=false'. It should report authPaused=true or explicitly log the pause instead of reporting the opposite state.
   - Class: live-reproduced (basis: Executed the unchanged module body in a Node VM with external dependencies mocked in memory. Injecting a paused auth decision reproduced the false log while confirming that no daemon work ran.)
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
