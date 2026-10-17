---
bornAs: x4pfhf5
kind: story
size: 3
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
blockedBy: ["6201", "6203"]
scope: ["we:scripts/operations/delivery-digest.mjs", "we:scripts/operations/__tests__/delivery-digest.test.mjs", "we:scripts/conveyor/delivery-digest-job.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs", "we:scripts/settings/delivery-metrics.json"]
dateOpened: "2026-10-17"
tags: []
---

# Weekly delivery digest: a one-page Sunday 20:00 ET summary with week-over-week arrows

A health-watch job reads only the collector history contract from 6201 and writes a one-page Markdown digest and a JSON summary to the handoff folder, with week-over-week arrows per measure. Code in we:scripts/operations/delivery-digest.mjs and we:scripts/conveyor/delivery-digest-job.mjs. Declare the job in we:scripts/conveyor/health-watch.mjs and we:skills-src/conveyor/daemon-manifest.mjs using the collector wiring delivered by 6203; health-watch's morning status output links the latest successfully published digest. Both prerequisites must land first, including 6203's prerequisite PR #5487.

This card owns delivery.digest.schedule (default Sunday 20:00 America/New_York) in we:scripts/settings/delivery-metrics.json; preserve collector-owned delivery.metrics.* and the protocol list. The blockedBy edges serialize the shared settings, health-watch and manifest edits. Compare the seven completed ET dates preceding the Sunday run with the preceding seven dates; aggregate counts by sum and other measures by their documented collector units/aggregation. Mark incomplete windows and unavailable values explicitly; compare only compatible measures. Arrows ↑/↓/→ mean positive/negative/zero numeric delta, not good/bad. An unavailable baseline yields an unavailable comparison, not a zero baseline.

## Acceptance

- [A1] **Executable** — From WE, `npm run test:unit -- delivery-digest.test` selects we:scripts/operations/__tests__/delivery-digest.test.mjs by filename filter; it fails before implementation and passes after, exercising every named case below.

## Test plan

All cases below are CAPABILITY tests (RED before implementation) in we:scripts/operations/__tests__/delivery-digest.test.mjs. Exercise the registered health-watch job and morning status output, not just the digest formatter, with fixture history, isolated handoff/state roots and a controlled clock.

- `runsSundayAt2000NewYork` — RED; assert manifest membership and health-watch invocation exactly at Sunday 20:00 ET in winter/summer and both DST weeks, zero invocations at adjacent ticks, and one invocation per scheduled occurrence across repeated ticks/restarts. Assert an overridden delivery.digest.schedule changes invocation times and invalid settings refuse execution.
- `writesMarkdownAndJsonWithWeekOverWeekArrows` — RED; assert both artifacts, the same period/repo/schema identifiers and all measures, exact independently computed aggregates/deltas, ↑/↓/→ for positive/negative/zero, and unavailable comparison for absent/zero percentage denominators. The Markdown is one page of summary, with details in JSON.
- `morningStatusLinksDigest` — RED; invoke the actual health-watch morning status path after publication, assert it emits the completed Markdown digest link; failure/partial publication retains the previous successful link and first-run absence is explicit.
- `readsOnlyHistoryAndPreservesCollectorSettings` — RED; trace metric-data reads through the registered job and assert history is their sole source (schedule configuration reads are separate); raw-ledger reads throw and history bytes stay unchanged. After adding digest defaults, assert delivery.metrics.* and the protocol list are unchanged.
- `handlesPartialWeeksAndInvalidHistory` — RED; assert ET window boundaries, gaps/missing baseline and null reasons label incompleteness without invented values, incomplete final line preserves complete rows with a warning, and malformed complete rows, duplicate repo/date rows or unsupported schemas refuse publication. Stream complete rows with a 1 MiB per-line cap; oversized lines fail explicitly.
- `readsConsistentHistoryDuringCollectorPublication` — RED; atomically replace collector history during the real digest read; assert all aggregates and both output artifacts derive from one complete old or new history snapshot, without mixed dates or generations.
- `publishesConsistentArtifactsAcrossRetries` — RED; race two runs for the same period, crash between artifact writes, recover a stale lock and resume its expired holder; assert one committed matching artifact pair and one status link. Stage a generation then atomically publish its pointer only after both files exist; re-read state under lock and fence stale writers.
- `scopesAndEscapesDigestData` — RED; mixed-repo history stays separate; protocol names with Markdown links, backticks, HTML or newlines are inert escaped text, JSON round-trips, output paths stay in the handoff root, and metadata names the digest producer and collector period without leaking source secrets.

## Non-goals

- [N1] No raw-ledger collection, dashboard, retrospective mutation of history or external message sending. Morning status integration emits a local artifact link.

## Edge cases this change must handle

1. **Untrusted text** — Escape history text in Markdown and serialize JSON; constrain output paths (`scopesAndEscapesDigestData`). No network receive/write endpoint is added, so HTTP body caps, CSRF and request rate limits do not apply.
2. **Truncated reads** — Ignore an incomplete tail with a warning; reject malformed complete and oversized records and label incomplete periods (`handlesPartialWeeksAndInvalidHistory`).
3. **Shared state files** — Read a consistent history snapshot (`readsConsistentHistoryDuringCollectorPublication`); serialize period publication and atomically publish the completed pair's pointer with fenced lock recovery (`publishesConsistentArtifactsAcrossRetries`).
4. **Fail closed** — Invalid history/settings fails publication and preserves the last successful artifacts/link; missing baseline stays unavailable (`handlesPartialWeeksAndInvalidHistory`, `runsSundayAt2000NewYork`, `morningStatusLinksDigest`).
5. **Identity scoping** — Compare one repo's compatible measures and keep output paths inside the handoff root (`scopesAndEscapesDigestData`).
6. **State over time** — Completed ET windows, DST, repeated ticks, restarts and week-over-week comparisons are covered by the schedule, partial-week and publication cases.
7. **Who wrote it** — Artifact metadata identifies the digest producer, repo, source period and schema; a status link names only a committed generation (`scopesAndEscapesDigestData`, `morningStatusLinksDigest`).

## Risks

Non-additive measures need documented aggregation before comparison (do not average daily percentiles as a weekly percentile). The future morning status hook must be exercised through health-watch; a formatter-only link test is insufficient. Two output files require a committed-generation pointer to avoid mixed generations.
