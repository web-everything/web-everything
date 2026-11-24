---
kind: story
size: 2
status: open
scope: ["we:blocks/time-tracks/TimeTracks.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from frontier-ui/frontierui#53 (head dc9a84177)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#53 (reviewed head `dc9a84177e2721be35e60df545a45824b08bcea1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/time-tracks/TimeTracks.ts:178` — (edge-case, degraded) Items at the domain endpoint collapse to zero content width
   - Scenario: Use domain [0,1000], today 500, and one lane containing {id:"release",label:"Release",at:1000}. On a 320px track with a 60px label, fitItems sets left to calc(1 * 100%), min-width to 0, and width to calc(100% - 100%). Combined with overflow:hidden, this clips the label to an unusable sliver. A valid endpoint item should retain a readable boundary label. Increasing track width cannot resolve this case.
   - Class: correctness-in-normal-use (basis: Executed the actual createTimeTracks and fitItems functions in Happy DOM with supplied clientWidth=320 and offsetWidth=60; observed the zero-width style. Native browser painting was not exercised. Endpoint times are explicitly accepted, and the same calculation leaves zero content width at every positive track width.)
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
