---
kind: story
size: 5
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/delivery-metrics.mjs", "we:scripts/operations/__tests__/delivery-metrics.test.mjs", "we:scripts/settings/delivery-metrics.json"]
dateOpened: "2026-10-17"
tags: []
---

# Delivery metrics collector: a daily snapshot of delivery measures

The collector in we:scripts/operations/delivery-metrics.mjs reads source ledgers without modifying them and publishes one idempotent row per America/New_York calendar date to the coordination state's delivery-metrics JSON-lines history. Measures cover throughput split product vs delivery, lead time p50/p90, fix rounds per PR, needs-you episodes and wait, verdict-ledger agreement, coroner incidents, daemon restarts, and sessions by provider, grouped as throughput, speed, quality, operator load, trust, reliability and cost. `--backfill=<days>` collects the preceding positive integer number of completed ET dates, oldest first; default collection is the preceding completed ET date.

Owns delivery.metrics.enabled (default true), delivery.metrics.schedule (default daily 00:15 America/New_York), and the protocol list in we:scripts/settings/delivery-metrics.json. New protocols require settings changes alone. Each protocol reports stage (proposed = card only, defined = pure rule exists, fixtures = replay fixtures exist, live = daemons call it), rule and fixture counts, and the measured overall percentage of delivery decisions behind a protocol (null with a reason when the denominator is unavailable or zero). Examples include the review/fix policy protocol of #5468 and the Decision API of #5461.

The consumer contract is a versioned row with ET date, collection timestamp, repo identity, the seven measure groups, a delivery-protocols group and per-field availability reasons. Use null plus a reason for an unavailable measure, never a fabricated zero. Document exact field names, units and per-measure multi-day aggregation semantics alongside fixtures in the test file before building the consumers. Daily percentiles may be displayed as daily series but cannot be averaged into a weekly percentile; mark that weekly aggregate unavailable unless the row carries sufficient aggregation data. Dashboard xeluwak and digest x4pfhf5 consume this contract. Daily health-watch wiring belongs to xxvode8, which waits for PR #5487; this card does not touch its files. The digest card owns delivery.digest.schedule.

## Acceptance

- [A1] **Executable** — From WE, `npm run test:unit -- delivery-metrics.test` selects we:scripts/operations/__tests__/delivery-metrics.test.mjs by filename filter; it fails before implementation and passes after, exercising every named case below.

## Test plan

All cases below are CAPABILITY tests (RED before implementation) in we:scripts/operations/__tests__/delivery-metrics.test.mjs, using fixture ledgers, an isolated state root and a controlled clock.

- `selectsCompletedETDatesAcrossDST` — RED; assert the default date and backfill dates at UTC/ET midnight boundaries and both DST transitions, including 23/25-hour days.
- `rerunAndBackfillKeepOneRowPerETDate` — RED; run the CLI twice for a date and an overlapping backfill; assert one row per repo/date, unchanged prior rows and oldest-first new rows. Reject zero, negative, non-integer and excessive backfill (cap 366 days) before writing.
- `collectionLeavesSourceLedgersUnchanged` — RED; compare source bytes and mtimes before/after daily, backfill and failing collection; only the derived history/its lock may change.
- `calculatesEveryMeasureFromFixtures` — RED; assert exact values and units for every listed measure, product/delivery split, p50/p90, provider groups and each consumer measure group against independently calculated fixture expectations.
- `settingsDefaultsAndOverridesApply` — RED; assert enabled=true and 00:15 America/New_York defaults, cascade overrides and refusal of invalid configuration without changing history.
- `settingsOnlyProtocolAppearsInSnapshot` — RED; add a protocol solely in settings, assert it appears; fixtures cover all four stages, exact rule/fixture counts and known coverage numerator/denominator, plus null/reason for zero or unknown denominator.
- `publishesVersionedConsumerContract` — RED; assert exact schema version, date, timestamps, repo identity, field names, units, per-measure multi-day aggregation semantics, protocol shape and availability reasons on every JSON line; consumer fixtures use this same row contract. Assert weekly percentile aggregation is unavailable without sufficient data, not an average of daily percentiles.
- `concurrentWritersAndRecoveryPreserveHistory` — RED; race two real child collectors (daily/backfill) over one state root; assert unique repo/date rows and valid JSON lines. Inject a crash before publication and stale-lock recovery; assert prior committed history survives, re-read after locking, and a resumed expired holder cannot publish over its successor.
- `partialSourcesAreExplicitAndCorruptionIsRefused` — RED; incomplete source tail is ignored with an availability reason, malformed complete source records degrade affected fields, missing source yields null/reason, and corrupt existing history refuses publication without overwriting it. An incomplete history tail is repaired under the writer lock while preserving complete rows.
- `scopesAndBoundsInputs` — RED; mixed-repo fixtures do not mix counts; path traversal, shell-like labels and oversized records (over 1 MiB per line) are rejected or treated as inert data with a diagnostic; command-like strings cause no execution. Record provenance identifies the collector and input availability without copying source secrets.

## Non-goals

- [N1] No daemon registration, dashboard, digest scheduling or source-ledger repair. Collection is read-only with respect to source ledgers; the derived history is a write surface.

## Edge cases this change must handle

1. **Untrusted text** — Settings and ledger strings are data, never commands; bound each input line to 1 MiB and constrain configured paths to approved roots (`scopesAndBoundsInputs`). No HTTP endpoint is added, so request-body, CSRF and network rate controls do not apply.
2. **Truncated reads** — Read all complete source records, flag incomplete tails; repair only an incomplete history tail under the lock and refuse malformed complete history (`partialSourcesAreExplicitAndCorruptionIsRefused`).
3. **Shared state files** — Serialize history publication, re-read after lock acquisition, publish atomically, and fence an expired writer; two writers/crash/stale-lock behavior is tested by `concurrentWritersAndRecoveryPreserveHistory`.
4. **Fail closed** — Invalid settings or corrupt complete history leaves committed history unchanged; unavailable sources produce null/reason for affected fields (`settingsDefaultsAndOverridesApply`, `partialSourcesAreExplicitAndCorruptionIsRefused`).
5. **Identity scoping** — Filter source events by repo identity and key idempotency by repo/date (`scopesAndBoundsInputs`, `rerunAndBackfillKeepOneRowPerETDate`).
6. **State over time** — Completed ET dates, DST, repeat runs, overlapping bounded backfills and schema versions are covered by the date, idempotency and consumer-contract cases.
7. **Who wrote it** — Collector provenance and timestamps describe derived rows; collection never changes source provenance (`scopesAndBoundsInputs`, `collectionLeavesSourceLedgersUnchanged`).

## Risks

Ledger availability and definitions of percentiles can produce misleading trends; fixture expectations must fix units, denominators and missing-field semantics. Concurrent publication and DST are the main data-loss/date risks, covered above.
