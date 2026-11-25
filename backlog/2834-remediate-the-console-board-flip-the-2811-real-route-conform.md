---
bornAs: xnlo0ns
kind: story
size: 8
parent: "2804"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: plan step PD-BOARD mounts the board in the new shell (final route and tokens exist)."
dateParked: "2026-11-22"
blockedBy: []
scope:
  - "plateau-app:src/backlog-view/lane-board.ts"
  - "plateau-app:src/backlog-view/lane-board.css"
  - "plateau-app:src/styles/layout.css"
  - "plateau-app:index.html"
dateOpened: "2026-08-02"
dateStarted: "2026-08-02"
tags: [plateau-loop, ui-fidelity, render-slice, human-verify, console-board, slice-uifg]
---

# Remediate the console board — flip the #2811 real-route conformance oracle RED to GREEN

The board-side REMEDIATION of the ORIGINAL failure the UI-Fidelity Gate (#2804) exists to prevent: the live,
assembled `/console-board` route rendered poorly (duplicated shell chrome inside the page, a flex-collapsed
center, no dark theme cascade) even though every board-build story (#2789–#2796) was `resolved`. The #2811
oracle now RED-flags exactly these defects and doubles as the acceptance gate — it goes GREEN only once the
board is actually fixed. WE validates; plateau-app renders (MEMORY #6 preserved).

## The RED signals eliminated (from the #2811 oracle — both themes, empty + populated + overflow seeds)
- **chrome-banner-in-route / chrome-duplicate-header** — the board built its own top-frame + exec header
  (`.lb-topframe` + `.lb-exec`, both `<header>`) INSIDE the embedded route, duplicating the host shell. Now ZERO
  banner landmarks in the route (the shell owns the one banner).
- **chrome-duplicate-brand** — the board re-drew a second `#mesa-mark` brand lockup; removed. The shell sidebar
  owns the one brand slot (its `.brand-mark` renamed → `.sidebar-brand-mark` so the one lockup matches the
  oracle's brand-mark selector exactly once, not twice).
- **grid-collapsed / grid-template-collapsed** — the center was a FLEX fallback (`grid-template-columns: none`)
  and the 3-lane populated seed collapsed to 2 columns at 1440w. Now a real CSS grid: three full ~250px tracks
  (each ≥ min width), non-overlapping, non-zero cells, no sideways scroll.
- **theme-cascade-static** — `shell-top-bar` / `page-background` / `route-region` stayed light on a dark board.
  Now an unlayered dark host-surface cascade repaints every host token between light and dark.
- (required-webcase-set + legend + pool template were already honestly present — preserved.)

## Approach
- Demote the two board `<header>` chrome elements to `<div>` and drop the board's re-drawn brand lockup.
- Make `.lb-window` a real CSS grid (`repeat(--lb-cols, minmax(200px, 1fr))`); drop the packing floor from 300
  to the grid's own 200px so three full columns realize inside the ~768px embedded center at 1440w, growing
  back toward the ratified ~300px (§6/#2554) via `1fr` as the viewport widens.
- Add a dark-theme host-surface cascade (`plateau-app:src/styles/layout.css`) keyed on BOTH
  `:root[data-theme="dark"]` (the board toggle → `pl:theme`) AND `prefers-color-scheme: dark`, mirroring the
  board root's own pattern.

## Acceptance (render-slice / human-verify — do NOT auto-resolve on green)
- The harness `plateau-app:scripts/dev/fidelity-render.mjs` run against the `/console-board` contract with
  `--expect green` flips (was `--expect red`): 0 violations, both themes × empty/populated/overflow.
- The vitest gate (`plateau-app:tests/fidelity/real-route-fidelity.test.ts`) stays green; the live `e2e` oracle
  (`plateau-app:tests/visual/real-route-fidelity.spec.ts`) goes GREEN.
- Full plateau-app `npm test` stays green; `we:` `check:standards` passes.
- Delivered via a plateau-app PR left OPEN for the orchestrator's independent review of the red→green proof.

Ruled PARK in the master plan (2026-11-22), kept parked (operator ruling). No blockedBy on #2811: #2811's red-to-green proof depends on this remediation, so that edge would be circular. Unpark when: plan step PD-BOARD mounts the board in the new shell (final route and tokens exist). #2811's failing oracle is written first and is not deferred.
