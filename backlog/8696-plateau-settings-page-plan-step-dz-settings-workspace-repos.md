---
bornAs: xn8wrsi
kind: story
locus: plateau-app
size: 5
status: open
blockedBy: ["8695"]
dateOpened: "2026-11-22"
tags: [plateau, plateau-ui, design-plan]
---

# Plateau Settings page (plan step DZ-SETTINGS): workspace, repos, ladder, date policy, theme, Labs toggle, batching, PR-size policy

Plan step DZ-SETTINGS in the plateau design plan: one Settings page hosting workspace, repos, ladder, date policy, theme, Labs toggle, batching and PR-size policy; /settings is a stub today. Built in plateau-app from WE and FrontierUI blocks; after DZ-SHELL; slices #3119, #2472, #2461 feed it.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: the Settings route renders workspace, repos, ladder, date policy, theme, Labs toggle, batching and PR-size policy controls, and /settings is no longer a stub. Linked plan step: DZ-SETTINGS.



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
