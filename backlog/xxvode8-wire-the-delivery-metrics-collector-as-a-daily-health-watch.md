---
kind: story
size: 2
status: active
scaffoldedBy: "delivery-metrics-cards-2-lane-16-51caddc5"
dateScaffolded: "2026-10-17"
blockedBy: ["xpdw3em"]
scope: ["we:scripts/conveyor/delivery-metrics-job.mjs", "we:scripts/conveyor/health-watch.mjs", "we:skills-src/conveyor/daemon-manifest.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Wire the delivery-metrics collector as a daily health-watch job

Run the delivery-metrics collector (we:scripts/operations/delivery-metrics.mjs) once a day as a health-watch job at 00:15 America/New_York, declared like the nightly coroner: a job module we:scripts/conveyor/delivery-metrics-job.mjs, a health-watch entry and a daemon manifest entry, honouring delivery.metrics.enabled and delivery.metrics.schedule. Split out of the collector card because PR #5487 (no card of its own) holds the health-watch and manifest files; start after it lands. Blocked on the collector card xpdw3em.

## Acceptance

- [A1] **Executable** — a test shows the job is declared in the manifest and calls the collector once per day; it fails before this item lands and passes after.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
