---
bornAs: xqr3x2x
kind: story
locus: plateau-app
size: 5
status: open
dateOpened: "2026-11-22"
tags: [plateau, plateau-ui, design-plan]
---

# Plateau state patterns (plan step DZ-STATES): loading, empty, error and offline blocks

Plan step DZ-STATES in the plateau design plan: shared loading, empty, error and offline state blocks (FrontierUI block, plateau-app adopts) so every screen shows honest states; blocks DZ-TODAY and DZ-CATALOG. See the DZ-STATES prep.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: one shared loading, empty, error and offline block set exists and the first adopting screen shows each state in a webcase. Linked plan step: DZ-STATES.



## Non-goals

- [N1] No work outside plateau-app and its FrontierUI blocks; no new local UI component (cardinal rule), gaps go to the plateau-app missing-blocks list.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: planning-level card; the build slices carry their own edge-case handling.
2. **Truncated reads** — n/a: planning-level card; the build slices carry their own edge-case handling.
3. **Shared state files** — n/a: planning-level card; the build slices carry their own edge-case handling.
4. **Fail closed** — n/a: planning-level card; the build slices carry their own edge-case handling.
5. **Identity scoping** — n/a: planning-level card; the build slices carry their own edge-case handling.
6. **State over time** — n/a: planning-level card; the build slices carry their own edge-case handling.
7. **Who wrote it** — n/a: planning-level card; the build slices carry their own edge-case handling.
