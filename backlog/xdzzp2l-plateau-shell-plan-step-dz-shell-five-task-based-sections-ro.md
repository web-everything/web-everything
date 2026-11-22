---
kind: story
size: 8
status: open
dateOpened: "2026-11-22"
tags: []
---

# Plateau shell (plan step DZ-SHELL): five task-based sections, route table, mobile bottom bar

Plan step DZ-SHELL in the plateau design plan (PL-ROUTES: five task sections own the URLs, extraction-ready through module boundaries; PL-FOUND-TIMING: DZ-FOUND repoint lands first). New route table declares a guard per route and a mobile bottom bar; folds #3130, #3827 and the superseded /wip phone cards.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: the new route table declares a guard for every route, the five task sections own the URLs, and a logged-off visit to a guarded route is refused (covers #3130). Linked plan step: DZ-SHELL.



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
