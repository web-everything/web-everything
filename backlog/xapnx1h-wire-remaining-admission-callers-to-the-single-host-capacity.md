---
kind: story
size: 5
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/lib/dispatch-throttle.mjs", "we:scripts/lib/host-load.mjs", "we:scripts/lib/lane-transcript-backfill.mjs", "we:scripts/lib/resource-admission.mjs"]
dateOpened: "2026-11-10"
tags: []
---

# Wire remaining admission callers to the single host-capacity module (R853 follow-up)

we:scripts/lib/host-capacity.mjs now decides review daemon and red-team queue admission. Still on their own rules: we:scripts/readiness/heavy-admission.mjs cap and remote routing, we:scripts/lib/dispatch-throttle.mjs hostLoadGate, lane GC (we:scripts/lib/host-load.mjs scheduledLaneGc), we:scripts/lib/lane-transcript-backfill.mjs, and rebuild smoke admission via we:scripts/lib/resource-admission.mjs (after the smoke concurrency cap lands). Map each to a class (blocker, review, smoke, build, background) and remove the old load-per-core gate.

## Acceptance

- [A1] **Executable** — `npx vitest run` on each wired caller test: a high load average with idle CPU above the class threshold admits; a misread sampler holds.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: this card only wires callers; thresholds stay in the host-capacity settings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: numeric readings only.
2. **Truncated reads** — n/a: no file reads added.
3. **Shared state files** — the sampler history is read-only.
4. **Fail closed** — an unreadable sampler or settings holds, never admits.
5. **Identity scoping** — n/a: host-wide.
6. **State over time** — a window average, not one spike.
7. **Who wrote it** — n/a: no authored input.
