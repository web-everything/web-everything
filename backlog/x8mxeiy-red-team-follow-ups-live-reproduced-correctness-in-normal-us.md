---
kind: story
size: 2
status: open
scope: ["we:blocks/time-tracks/TimeTracks.ts", "we:blocks/time-tracks/TimeTracksElement.ts"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from frontier-ui/frontierui#53 (head 022d10e0a)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#53 (reviewed head `022d10e0a9d31f20f05daa4f1f60098330436dfd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/time-tracks/TimeTracks.ts:184` — (failing-input, degraded) Near-end fitting reverses visual chronology and can obscure earlier items
   - Scenario: Use domain [0,1000], today 500, and two items in one lane at 950 and 990, each with a natural width of 160px, on a 1000px track. fitItems keeps the first item at 950px but anchors the later item at 840px using left:auto and right:0. The later item appears earlier and overlaps the first. It should retain its 990px start and wrap or truncate, as the stated acceptance requires.
   - Class: live-reproduced (basis: Executed the actual fitItems function with stubbed track and item measurements. Observed the 950 item retain its time-based left position while the 990 item switched to right anchoring with max-content minimum width.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:blocks/time-tracks/TimeTracksElement.ts:83` — (failing-input, degraded) Direct SVG chart content bypasses keyed item placement
   - Scenario: Configure domain [0,1000], today 500, and lane build with item chart at 100. Author a direct child SVG carrying data-lane-id="build" and data-item-id="chart". SVGSVGElement fails the instanceof HTMLElement filter, so the SVG goes into the unplaced section below the timeline while the chart item retains its placeholder label. Matching keyed SVG content should occupy its configured item slot.
   - Class: correctness-in-normal-use (basis: SVG elements are not HTMLElements. The placement filter excludes them, and the remaining-child handling moves them to the unplaced section. This repository's SvgChartRenderer returns SVGSVGElement, making this an ordinary chart-composition input.)
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
