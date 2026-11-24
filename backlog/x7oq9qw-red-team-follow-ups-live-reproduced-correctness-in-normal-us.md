---
kind: story
size: 2
status: open
scope: ["we:blocks/time-tracks/TimeTracksElement.ts", "we:blocks/time-tracks/TimeTracks.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from frontier-ui/frontierui#53 (head 50bae164d)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#53 (reviewed head `50bae164dac1c8a52dfa9beb028b19b17d89479b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/time-tracks/TimeTracksElement.ts:61` — (failing-input, degraded) Matching SVG content is left unplaced instead of entering its item slot
   - Scenario: Configure domain 0–1000, today 500, lane build with item chart at 100. Supply a direct-child SVG carrying data-lane-id="build" and data-item-id="chart". The HTMLElement filter excludes SVGElement, so the SVG appears in the unplaced region below the timeline while the item retains its fallback label. The matching SVG should move intact into the chart item.
   - Class: live-reproduced (basis: Executed the checked-out TypeScript implementation in Happy DOM. Confirmed the original SVG node remained present, was outside the matching item, and had data-slot="unplaced" as its closest slot.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:blocks/time-tracks/TimeTracks.ts:137` — (edge-case, degraded) ArrowRight moves focus leftward for items supplied out of time order
   - Scenario: Create one lane with domain 0–1000, today 500, and items ordered at 900 then 600. Focus the lane, press Enter, then ArrowRight. Focus moves from position 90% to position 60%, reversing the visual direction. Item navigation should follow horizontal time order so ArrowRight advances rightward regardless of configuration order.
   - Class: live-reproduced (basis: Executed the checked-out factory in Happy DOM and dispatched keyboard events. Enter focused the item with data-x="0.9"; ArrowRight then focused data-x="0.6". The configuration is accepted without any sorted-input requirement.)
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
