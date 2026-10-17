---
kind: story
size: 5
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/delivery-metrics.mjs", "we:scripts/operations/__tests__/delivery-metrics.test.mjs", "we:scripts/conveyor/delivery-metrics-job.mjs", "we:scripts/conveyor/health-watch.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:scripts/settings/delivery-metrics.json"]
dateOpened: "2026-10-17"
tags: []
---

# Delivery metrics collector: a daily snapshot of delivery measures as a health-watch job

A read-only daily collector (we:scripts/operations/delivery-metrics.mjs) snapshots about 10 delivery measures for one ET day (throughput split product vs delivery, lead time p50/p90, fix rounds per PR, needs-you episodes and wait, verdict-ledger agreement, coroner incidents, daemon restarts, sessions by provider) and appends one idempotent row per date to a history file named delivery-metrics (JSON lines) in the coordination state dir. Runs daily after midnight ET as a health-watch job declared like the nightly coroner (we:scripts/conveyor/nightly-coroner-job.mjs, we:scripts/conveyor/health-watch.mjs, we:skills-src/conveyor/daemon-manifest.mjs), with cascade settings in we:scripts/settings/delivery-metrics.json (delivery.metrics.enabled, delivery.metrics.schedule, delivery.digest.schedule). Has a backfill option. The row shape is the contract the dashboard and digest read. [A1] Executable: node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/delivery-metrics.test.mjs

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/delivery-metrics.test.mjs` fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: the three cards are split by piece; this one does not build the other two.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
2. **Truncated reads** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
3. **Shared state files** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
4. **Fail closed** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
5. **Identity scoping** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
6. **State over time** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
7. **Who wrote it** — n/a: read-only metrics over trusted local ledgers; no untrusted text is executed.
