---
kind: story
size: 5
status: open
dateOpened: "2026-11-22"
tags: []
---

# Plateau onboarding (plan step DZ-ONBOARD): first-run flow for a new workspace

Plan step DZ-ONBOARD in the plateau design plan: a first-run onboarding flow that connects a workspace and repos and lands the user on Today. Built in plateau-app from WE and FrontierUI blocks; after DZ-SHELL, DZ-STATES and DZ-SETTINGS.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: a new workspace can complete the first-run flow end to end and lands on Today. Linked plan step: DZ-ONBOARD.



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
