---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/agy-usage-reader.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7331 (head f6822c981)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7331 (reviewed head `f6822c98125b62e8612065b6cb31e617e3ce25ad`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/agy-usage-reader.mjs:110` — (edge-case, degraded) A partial login repaint still receives /usage and Enter.
   - Scenario: Show the signed-in prompt until Escape is sent, then emit the login fixture only up to 'Welcome to the'. If the remaining login text arrives after the 300 ms step delay, the current frame has neither login markers nor signed-in markers. The callback nevertheless sends /usage\r. Replaying the remaining fixture then resolves signed-out, after keys have already reached the login screen. The callback should require fresh positive signed-in evidence before sending /usage, and wait without typing during an unresolved repaint.
   - Class: live-reproduced (basis: Executed collectAgyUsage with injected child streams, the captured login fixture, default startup and step delays, real timers, and stubbed process cleanup. It resolved signed-out while recording stdin writes of Escape followed by /usage\r. This reproduces the chunk-boundary failure; an actual authentication transition was not exercised.)
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
