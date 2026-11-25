---
bornAs: xeluwak
kind: story
locus: plateau-app
size: 5
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
blockedBy: ["6201", "4006"]
scope: ["plateau-app:src/delivery/delivery-view.ts", "plateau-app:src/delivery/delivery-view.test.ts", "plateau-app:src/delivery/delivery-read.ts", "plateau-app:src/main.ts", "plateau-app:index.html"]
dateOpened: "2026-10-17"
tags: []
---

# Delivery dashboard: a /delivery/ page in plateau-app charting the metrics history

A /delivery/ page in plateau-app (the product), routed like /wip: a route template and nav link in plateau-app:index.html, a title entry and mount in plateau-app:src/main.ts, and a view in plateau-app:src/delivery/delivery-view.ts. The reader in plateau-app:src/delivery/delivery-read.ts reads ONLY the versioned collector history contract delivered by 6201 (delivery-metrics JSON lines, retained in WE). It charts throughput, speed, quality, operator load, trust, reliability and cost. The "Delivery protocols" panel shows each protocol's stage (proposed → defined → fixtures → live), rule and fixture counts, and overall percent of delivery decisions behind a protocol, all taken from history. Dev port 4000.

## Acceptance

- [A1] **Executable** — From the plateau-app repository root, `npm test -- delivery-view.test` selects plateau-app:src/delivery/delivery-view.test.ts by filename filter; it fails before implementation and passes after, exercising every named case below.

- [A2] Every carried block below is copied verbatim from its source card (PL-WIP-CLEANUP, 2026-11-22); each requirement in it needs a named test, and the Attention queue needs a named owner. The live-step work is blocked on #4006 (the step status producer), so no acceptance runs against fixtures alone. The live-step tests must assert that EVERY step of a card renders with its own state, not just one step.

### Carried from #3736 (verbatim)

(2) Every Attention finding becomes a queued item automatically. A finding with a live handler and a live runner is not shown in Attention and appears under Work items as queued. A finding with no handler is filed once as a backlog item (dedup by rule plus target) and /wip shows one line 'N gaps queued (#ids)'. A finding still unresolved past a deadline (about 2 h) shows one line naming the item. Needs you is unchanged. [...] (3) Once the unified planned-items intake exists (the `track` operation: tracker notes plus filed backlog items as the only two sources, operator 2026-09-20), /wip shows only the TOP planned items (about 5, ranked) as a compact table (id, short title, state) in place of the Next section, not the whole list; the FULL unified list is available on demand through a separate view (a `--planned` flag on the report, same compact table) and the operator wants it printed in full once, when the unified source first exists. Blocked on the `track` story, which is not filed yet.

### Carried from #4007 (verbatim)

The Plateau WIP dashboard reads the step status record and shows each card live steps and their state. Locus plateau-app.

### Carried from #4199 (verbatim)

Add a snapshot-driven activity panel inside each Doing/Needs-you card's existing disclosure: list each matching session/job separately, with role, state, started/last-event time, outcome, and an openable transcript link or copyable path. Preserve #4198 as the producer dependency and #3931 as the parent; this is the non-live slice, not the fuller L2/L3 timeline.

The scoped Plateau tests and repo gate pass; a real card displays its review job and fixer separately with all required fields and verified transcript access/path fallback; healthy-empty, unknown and stale evidence remain distinguishable; publisher/relay compatibility and keyboard/phone use are observed.

### Carried from #5358 (verbatim)

It must cover known card focus/highlight, known session panel, and unknown card/session notice.

1. **Untrusted text** — Parse query values as opaque IDs; render unknown-ID notices as text, never HTML or raw selectors.
2. **Truncated reads** — If the card/session feed is incomplete, show loading/unavailable rather than declaring a missing identity.
4. **Fail closed** — A missing or unauthorized session must not open another panel or trigger a control action.
5. **Identity scoping** — Resolve the exact card/session within the loaded authorized surface, not a substring match.
6. **State over time** — Wait for async mount/data before resolving; clear obsolete highlights when query/navigation changes.
7. **Who wrote it** — A URL selects a target; it does not prove the linker owns the session or authorize session actions.

### Carried from #5593 (verbatim)

- [A1] **Executable** — a glance deep-link test fails on the #217 head and passes after: with the fallback sample rendered first and the real snapshot arriving later, `?card=` scrolls and highlights on the real snapshot, and `?agent=` opens the panel there.
- [A2] The once-flags are spent only on the real snapshot, never on the fallback sample.
- [A3] Tests cover scroll-once (a later snapshot refresh does not scroll again) and the 128-char cap on the link value (a longer value is ignored, not truncated into a match).

1. **Untrusted text** — the query value is capped at 128 chars and matched as text, never injected as HTML or a selector.
6. **State over time** — scroll and open happen once per page load, not per snapshot refresh.

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
