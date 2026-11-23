---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7391 (head b230660f9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7391 (reviewed head `b230660f9f2e2f2f5df9bcc9fe3b8f8aeb9bd926`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-heal-loop.mjs:27` — (edge-case, degraded) The yield limit resets whenever the yielding child is restarted
   - Scenario: Keep a live foreign writer claim pending and set WE_CI_HEAL_MAX_REBUILD_YIELDS=2. Each child exits on its first yield; when the parent's controller starts another child, consecutiveRebuildYields starts at zero again. Five fresh-process launches all reported yield 1/2 and ran zero iterations. Healing therefore remains suppressed until the claim clears or expires, potentially indefinitely if refreshed. After two consecutive yields, the next launch should attempt normal read admission.
   - Class: live-reproduced (basis: Executed the unchanged runCiHealLoop implementation in five separate Node processes with an injected persistent claim and unused relative imports stubbed because dependencies are unavailable. All five exited rebuild-pending before iteration. Production launches separate child processes through spawnCiHealLoop, so its module-local counter likewise cannot survive restarts.)
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
