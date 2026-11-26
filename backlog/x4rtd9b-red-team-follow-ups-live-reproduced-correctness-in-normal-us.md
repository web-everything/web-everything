---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7522 (head a6f3d9973)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7522 (reviewed head `a6f3d99734c4feda36d0e6f9f956051e302cf40c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle.mjs:1460` — (edge-case, degraded) Valid standard costs of 51–60 points can never pass normal admission
   - Scenario: Call runGhSync(['api','user'], {throttle: {caller:'ordinary', points:51}}) against a fresh lock root with the default 300/minute budget and no competing traffic. The bucket caps at 60, but standard admission requires 10 remaining tokens, so this request can never qualify. The wrapper waits 120000 ms and executes only through the timeout bypass. Costs through 60 are explicitly accepted; these valid requests should have a normal progress path on an idle host instead of requiring a two-minute timeout.
   - Class: live-reproduced (basis: Reproduced through both acquireGhPointsSync and runGhSync using an injected clock and executor, with filesystem mutations redirected entirely to memory. Cost 50 executed immediately; costs 51 and 60 each delayed execution by exactly 120000 ms. The direct gate returned timedOut:true and bypass:'charged'.)
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
