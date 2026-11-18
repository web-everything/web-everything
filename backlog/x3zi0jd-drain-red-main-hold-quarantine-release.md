---
kind: story
size: 5
status: active
scaffoldedBy: "main-fix-quarantine-honour"
dateScaffolded: "2026-11-18"
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/red-main-quarantine-io.mjs"]
dateOpened: "2026-11-18"
tags: []
---

# Drain releases red-main-hold only when every required job is success or a fully quarantined failure

Runbook promises quarantine lets merging resume while main is red, but the drain holds anyway (we:scripts/merge-ai-prs.mjs). Release only when EVERY required job of main's latest completed run concluded success, or failed with a complete log that shows only quarantined test ids. Skipped, timed-out, cancelled, startup-failure or truncated logs always hold; unreadable evidence holds; main-write sweeps such as the stranded-card sweep keep the hold; per-PR overlap guards stay. Prior attempt (branch lane/main-fix-soak-owed-review at cc41e4b9d3) failed four audit rounds: skipped integration plus a quarantined unit failure released the hold; timed-out shards accepted; a log truncated after Test Files 1 failed accepted; aggregate failures assumed covered; stranded-card write-hold cleared; cancelled jobs omitted by readRunJobs; extra errors before the summary accepted. Fixes 0a352384ae.

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
