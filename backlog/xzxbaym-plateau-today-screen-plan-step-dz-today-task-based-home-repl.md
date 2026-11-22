---
kind: story
size: 5
status: open
dateOpened: "2026-11-22"
tags: []
---

# Plateau Today screen (plan step DZ-TODAY): task-based home replacing mock dashboard tiles

Plan step DZ-TODAY in the plateau design plan (ruled 2026-11-22 by the operator): a Today screen listing the top-5 prepared decisions, needs-you items and live state, replacing the hard-coded example tiles on the dashboard home. Built in plateau-app by composing WE and FrontierUI blocks; blocked by DZ-STATES and DZ-SHELL.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: the Today route renders the top-5 prepared decisions and needs-you items from the real data source, with no hard-coded example tiles left on the home route. Linked plan step: DZ-TODAY.



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
