---
kind: story
size: 2
status: open
scope: ["we:conformance-vectors/time-track.vectors.ts"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [coverage-or-style] from web-everything/web-everything#7352 (head d7ce58f30)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7352 (reviewed head `d7ce58f3022b4382fa9577bea243c5c170f22be4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:conformance-vectors/time-track.vectors.ts:91` — (edge-case, degraded) Keyboard vectors accept a candidate that traps focus in the middle lane.
   - Scenario: Focus zeta and press ArrowDown twice. A candidate that only handles movement from the first and last lanes leaves focus on alpha after the second key; the contract requires mu. Likewise, ArrowUp from alpha must reach zeta. All four shipped keyboard vectors pass this broken candidate because none starts from alpha or presses consecutive keys. Add middle-lane transitions or multi-key traversal cases.
   - Class: coverage-or-style (basis: A read-only Node mutation probe evaluated every shipped keyboard expectation against a candidate that moves zeta/down and mu/up to alpha but otherwise retains focus. All four passed, including timestamp and lane-order assertions. Both middle-lane transitions failed their contract expectations. This demonstrates an oracle coverage gap, not an observed failure in a runtime implementation.)
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
