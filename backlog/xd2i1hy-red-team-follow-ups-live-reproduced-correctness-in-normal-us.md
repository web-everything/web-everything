---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-fix-dispatch.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7501 (head c84b66961)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7501 (reviewed head `c84b66961da4193f949dbc28b1a3e5d81a9a1e9f`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-fix-dispatch.mjs:2987` — (edge-case, degraded) Stale claim metadata suppresses escalation for newly observed holder heads
   - Scenario: A live holder claim records headSha=acquisition-head. Holder-state reads are unavailable, while the region reader successfully observes pushed-head-1 and, on the next pass, pushed-head-2. The new holderHead expression prefers the stale acquisition head over observation.holderHead. Both escalations therefore use acquisition-head: the first posts, and the second returns alreadyPosted without notifying. A new observed holder head should receive its own escalation episode; the current region observation should precede acquisition metadata.
   - Class: live-reproduced (basis: An in-memory probe executed the extracted gate, region helpers, note planner and escalation recorder with injected IO. Two distinct observed current heads produced the same acquisition-head episode, one comment and one notification; the second call returned alreadyPosted.)
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
