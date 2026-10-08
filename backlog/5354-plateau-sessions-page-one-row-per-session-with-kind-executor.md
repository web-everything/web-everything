---
bornAs: xwtnr2y
kind: story
size: 3
parent: "5332"
status: active
scaffoldedBy: "p2-sessions"
dateScaffolded: "2026-10-08"
scope: ["plateau:index.html", "plateau:src/main.ts", "plateau:src/return-to.ts", "plateau:src/wip/sessions/sessions-view.ts", "plateau:src/wip/sessions/sessions-mount.ts", "plateau:src/wip/sessions/sessions.css"]
dateOpened: "2026-10-08"
tags: []
---

# Plateau /sessions page: one row per session with kind, executor, PR and card links, state, filters, ended hidden by default, live refresh (P2 of 128)

Slice P2 of cards-to-file 128. The /sessions route in plateau-app renders the sessions topic from P1 (5352) as plain HTML and CSS: one row per session (kind, executor and model, PR and card links, state, last activity, lane, transcript link plus copy button, subagent count), kind and state filters in the URL, ended rows hidden unless the Ended (last 24 h) filter is on, live refresh over the relay. Card links go to /wip?card=N (P3 adds the anchor). Plateau has no card system, so this card is filed in web-everything with a plateau: scope.

## Done when

1. **Executable** - in plateau-app: `npx vitest run plateau:src/wip/sessions/sessions-view.test.ts` fails before and passes after: the default view has no `done` row, `?ended=24h` adds them, `?kind=fix` shows only fix rows, chip counts ignore the filters, a card link is `/wip?card=N`, a PR link is a github.com pull URL. `npx playwright test plateau:tests/sessions.spec.ts` on a lane dev server (spare port, stopped by PID) shows ended rows hidden by default, shown by the filter, and no horizontal scroll at 390 px.

## Edge cases this change must handle

1. **Untrusted text** - every cell is set as text (no innerHTML); links are built only from numeric card ids and validated PR numbers.
2. **Truncated reads** - n/a: the page renders the whole validated topic from P1; no file reads.
3. **Shared state files** - n/a: the page holds no state beyond the URL filters.
4. **Fail closed** - no data, stale or error shows an age note and never asserts "nothing running".
5. **Identity scoping** - n/a: single-operator page.
6. **State over time** - a live delta repaints in place; "as of" age comes from the snapshot time.
7. **Who wrote it** - n/a: read-only page.
