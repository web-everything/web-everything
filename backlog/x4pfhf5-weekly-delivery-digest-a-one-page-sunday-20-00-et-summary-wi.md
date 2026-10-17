---
kind: story
size: 3
status: active
scaffoldedBy: "delivery-metrics-cards"
dateScaffolded: "2026-10-17"
blockedBy: ["xpdw3em"]
scope: ["we:scripts/operations/delivery-digest.mjs", "we:scripts/operations/__tests__/delivery-digest.test.mjs", "we:scripts/conveyor/delivery-digest-job.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/settings/delivery-metrics.json"]
dateOpened: "2026-10-17"
tags: []
---

# Weekly delivery digest: a one-page Sunday 20:00 ET summary with week-over-week arrows

A health-watch job (declared like the collector job, setting delivery.digest.schedule = Sunday 20:00 America/New_York in we:scripts/settings/delivery-metrics.json) reads the collector history and writes a one-page markdown and a JSON summary to the handoff folder, with week-over-week arrows per measure. The morning status links it. Code in we:scripts/operations/delivery-digest.mjs and we:scripts/conveyor/delivery-digest-job.mjs. [A1] Executable: node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/delivery-digest.test.mjs

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/delivery-digest.test.mjs` fails before this item lands and passes after.

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
