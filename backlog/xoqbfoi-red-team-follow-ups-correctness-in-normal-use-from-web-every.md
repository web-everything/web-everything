---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/flow-v0-interim/load.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7364 (head b7378806c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7364 (reviewed head `b7378806ce24d4bd45d425e02b4676fad43b6311`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/flow-v0-interim/load.mjs:43` — (failing-input, degraded) Feature detection mistakes ordinary state names for unsupported features
   - Scenario: Clone we:review-definition.mjs, rename parked to after, and update retry.onExhausted and the stop transition target accordingly. load throws 'Unsupported features: timers' although the definition contains no timer. The recursive scan interprets the state-map property named after as a timer field. This otherwise valid definition should load; feature detection must distinguish state identifiers from structural feature fields.
   - Class: correctness-in-normal-use (basis: Observed the rejection in the in-memory executor probe. This scan runs before schema validation, so the cached AJV 6 substitution used by the harness does not affect this failure.)
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
