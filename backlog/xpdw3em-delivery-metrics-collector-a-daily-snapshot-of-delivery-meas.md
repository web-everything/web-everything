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

# Delivery metrics collector: a daily snapshot of delivery measures as a health-watch job

A read-only daily collector (we:scripts/operations/delivery-metrics.mjs) snapshots about 10 delivery measures for one ET day (throughput split product vs delivery, lead time p50/p90, fix rounds per PR, needs-you episodes and wait, verdict-ledger agreement, coroner incidents, daemon restarts, sessions by provider) and appends one idempotent row per date to a history file named delivery-metrics (JSON lines) in the coordination state dir. Declares cascade settings in we:scripts/settings/delivery-metrics.json (delivery.metrics.enabled, delivery.metrics.schedule daily 00:15 America/New_York, delivery.digest.schedule Sunday 20:00 America/New_York) and the delivery protocol list. The daily health-watch wiring is NOT in this card: it is a follow-up story, because PR #5487 holds the health-watch and daemon manifest files. Has a backfill option (--backfill=<days>). Also reports a "delivery protocols" measure group: for each declared delivery protocol or pure policy rule (for example the review/fix policy protocol of card 5468 and the Decision API of #5461), its stage (proposed = card only, defined = pure rule exists, fixtures = replay fixtures exist, live = the daemons call it), the rule and fixture counts, and an overall percent of delivery decisions behind a protocol where measurable. The protocol list lives in the settings file so new protocols need no code change. The row shape is the contract the dashboard and digest read. [A1] Executable: node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/delivery-metrics.test.mjs

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
