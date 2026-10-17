---
kind: story
locus: plateau-app
size: 5
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
blockedBy: ["xpdw3em"]
scope: ["plateau-app:src/delivery/delivery-view.ts", "plateau-app:src/delivery/delivery-view.test.ts", "plateau-app:src/delivery/delivery-read.ts", "plateau-app:src/main.ts", "plateau-app:index.html"]
dateOpened: "2026-10-17"
tags: []
---

# Delivery dashboard: a /delivery/ page in plateau-app charting the metrics history

A /delivery page in plateau-app (the product), routed like the /wip page: a route template in plateau-app:index.html, a nav link, a title entry and a mount in plateau-app:src/main.ts, and a view in plateau-app:src/delivery/delivery-view.ts. It reads ONLY the collector history file (delivery-metrics, JSON lines, which stays in WE) and charts trends per measure group: throughput, speed, quality, operator load, trust, reliability, cost. Also shows a "Delivery protocols" panel listing each protocol's stage (proposed → defined → fixtures → live) with its rule and fixture counts and the overall percent of delivery decisions behind a protocol, read from the collector's delivery protocols measure group. Dev port 4000. [A1] Executable: npm test -- src/delivery (run in plateau-app).

## Acceptance

- [A1] **Executable** — `npm test -- src/delivery (run in plateau-app; locus plateau-app)` fails before this item lands and passes after.

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
