---
bornAs: xdzzp2l
kind: story
locus: plateau-app
size: 8
status: open
blockedBy: ["640"]
dateOpened: "2026-11-22"
tags: [plateau, plateau-ui, design-plan]
---

# Plateau shell (plan step DZ-SHELL): five task-based sections, route table, mobile bottom bar

Plan step DZ-SHELL in the plateau design plan (PL-ROUTES: five task sections own the URLs, extraction-ready through module boundaries; PL-FOUND-TIMING: DZ-FOUND repoint lands first). New route table declares a guard per route and a mobile bottom bar; folds #3130, #3827 and the superseded /wip phone cards.

## Acceptance

- [A1] **Executable** — a plateau-app webcase/e2e test (named by the build slice) fails before this lands and passes after: the new route table declares a guard for every route, the five task sections own the URLs, and a logged-off visit to each of the five routes #3130 lists is refused by a test (each of the five tested individually; #3130 itself is parked until beta). Linked plan step: DZ-SHELL.
- [A2] Carried from #2512: legacy URLs keep working after the route move: static, dynamic (:id) and query-string redirects from each old path to its new path, query string and id preserved, redirect runs before the auth guard, no redirect loop; one browser test per class, each asserting the real destination content mounts with no visible 404 (not only the URL).
- [A4] Auth membership is preserved: a test asserts that every route that is auth-guarded today stays guarded after the route table change (membership unchanged, so no previously protected route becomes public), and, in addition, each of the five routes #3130 lists is refused logged off. isProductRoute membership is otherwise unchanged (still excludes /skills and the four /console-* routes, as today).
- [A5] Carried from #2512: updated test fixtures and cross-link generators (plateau-app backlog-view mount and ruling-surface tests, runsPage test, the board visual spec) use the new paths; npm test, npm run test:e2e and npm run build pass in plateau-app; the stale route-prefix comment in plateau-app:index.html and the old /console-cases mention in plateau-app docs are fixed.
- [A6] Carried from #4984 (PL-WIP-CLEANUP): no horizontal overscroll or elastic scroll on mobile, and vertical scrolling does not regress; a mobile-viewport test asserts both.
- [A7] Carried from #4997 (PL-WIP-CLEANUP): no pinch zoom and no double-tap zoom on mobile, and focusing an input does not zoom the page; a mobile-viewport test asserts each.
- [A3] Carried from #2512: a sweep finds zero old internal links; every link, nav item and deep link points at the new path directly, not through a redirect.



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
