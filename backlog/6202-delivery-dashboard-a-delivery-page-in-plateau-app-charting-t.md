---
bornAs: xeluwak
kind: story
locus: plateau-app
size: 5
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
blockedBy: ["6201"]
scope: ["plateau-app:src/delivery/delivery-view.ts", "plateau-app:src/delivery/delivery-view.test.ts", "plateau-app:src/delivery/delivery-read.ts", "plateau-app:src/main.ts", "plateau-app:index.html"]
dateOpened: "2026-10-17"
tags: []
---

# Delivery dashboard: a /delivery/ page in plateau-app charting the metrics history

A /delivery/ page in plateau-app (the product), routed like /wip: a route template and nav link in plateau-app:index.html, a title entry and mount in plateau-app:src/main.ts, and a view in plateau-app:src/delivery/delivery-view.ts. The reader in plateau-app:src/delivery/delivery-read.ts reads ONLY the versioned collector history contract delivered by 6201 (delivery-metrics JSON lines, retained in WE). It charts throughput, speed, quality, operator load, trust, reliability and cost. The "Delivery protocols" panel shows each protocol's stage (proposed → defined → fixtures → live), rule and fixture counts, and overall percent of delivery decisions behind a protocol, all taken from history. Dev port 4000.

## Acceptance

- [A1] **Executable** — From the plateau-app repository root, `npm test -- delivery-view.test` selects plateau-app:src/delivery/delivery-view.test.ts by filename filter; it fails before implementation and passes after, exercising every named case below.

## Test plan

All cases below are CAPABILITY tests (RED before implementation) in plateau-app:src/delivery/delivery-view.test.ts, exercising the real reader and mounted route with the collector contract fixture.

- `readsOnlyCollectorHistory` — RED; instrument all filesystem/network data reads through the mounted page, assert every data target is the configured collector history, and make attempted raw-ledger/settings reads throw. Assert source bytes are unchanged.
- `mountsDeliveryRouteAndNavigation` — RED; load /delivery/ through the actual main entry and template, click the nav link, and assert the mounted view, title and active navigation; assert the dev configuration uses port 4000.
- `rendersMeasureGroupsAndProtocolValuesFromHistory` — RED; assert plotted dates/values for all seven groups and protocol labels, each of the four stages, counts and percentage against distinctive history fixture values; modifying fixture values changes the display without any raw-source access.
- `handlesMissingPartialAndUnsupportedHistory` — RED; empty/missing history shows unavailable, an incomplete final line preserves complete rows with a warning, malformed complete rows and unsupported versions show an explicit error, and null/reason renders unavailable rather than zero. Oversized lines (over 1 MiB) fail with a diagnostic instead of an unbounded allocation.
- `refreshUsesConsistentRepoDates` — RED; simulate an atomic history replacement during refresh and assert one complete old/new snapshot, selected repo filtering, chronological ET dates, duplicate-date error, gaps and staleness labels; no synthetic values fill gaps.
- `rendersLabelsAsText` — RED; hostile protocol names and availability reasons appear as text with no HTML/script execution or navigable injected links; provenance/timestamps from history are shown without presenting them as authentication.

## Non-goals

- [N1] No collection, raw-ledger aggregation, settings writes, digest generation or new data proxy endpoint. The page displays the collector's values and availability information.

## Edge cases this change must handle

1. **Untrusted text** — Render history labels as text (`rendersLabelsAsText`). No receive/write endpoint is added; CSRF, request-body caps and network rate limits are outside this local reader.
2. **Truncated reads** — Keep complete rows from an incomplete tail, flag it, and reject malformed complete/oversized rows; no silent last-N-lines parsing (`handlesMissingPartialAndUnsupportedHistory`).
3. **Shared state files** — Read a consistent snapshot during collector publication, write nothing and reject duplicate repo/date rows (`refreshUsesConsistentRepoDates`, `readsOnlyCollectorHistory`).
4. **Fail closed** — Missing/unsupported/corrupt data and null values show explicit unavailable/error states, never fallback raw-ledger reads or invented zeroes (`handlesMissingPartialAndUnsupportedHistory`, `readsOnlyCollectorHistory`).
5. **Identity scoping** — Render only the selected repo's rows (`refreshUsesConsistentRepoDates`).
6. **State over time** — Sort by ET date and show gaps/staleness; refresh reads newly published history without mixing snapshots (`refreshUsesConsistentRepoDates`).
7. **Who wrote it** — Show collector provenance and timestamps as data, not proof of authorship (`rendersLabelsAsText`).

## Risks

The cross-repo history path and schema must come from 6201's delivered contract. The history-only integration assertion must observe the mounted route, not just a mocked view, to catch accidental extra data sources.
