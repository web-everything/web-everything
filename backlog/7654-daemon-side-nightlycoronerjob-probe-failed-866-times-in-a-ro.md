---
bornAs: x3ek4ku
kind: story
size: 2
status: open
scope: ["we:coroner-false-findings.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Daemon-side nightlyCoronerJob probe failed 866 times in a row

MED priority hint. ## (held 2026-10-25 22:18 ET) Daemon-side nightlyCoronerJob probe failed 866 times in a row needs-you `coroner-failed` 02:17Z: the probe keeps retrying dead handles for nightly-coroner-2026-10-15/16/17 (attempts exhausted; the 10-17 run failed in we:coroner-false-findings.mjs, in a lane-1 path). It never gives up on an old date and never alerted until now. Fix: retire or close a past night's job after attempts are exhausted (record the outcome once); alert after N consecutive failures, not 866; check whether it duplicates the orchestrator's cron coroner.

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
