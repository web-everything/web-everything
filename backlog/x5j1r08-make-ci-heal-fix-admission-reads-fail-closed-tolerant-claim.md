---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/lib/fix-slot-borrow.mjs", "we:scripts/conveyor/fix-claim-store.mjs", "we:scripts/conveyor/unsupported-repo.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Make ci-heal/fix admission reads fail closed (tolerant claim reads, borrow gate, scope fallback, unreadable unsupported-repo store)

Audit of lane/ci-heal-own-loop found pre-existing fail-open paths: tolerant claim reads in we:scripts/operations/ci-heal-pr-dispatch.mjs (reserve fallback treats read failure as zero holders, empty-scope unfenced dispatch fallback), we:scripts/lib/fix-slot-borrow.mjs (unreadable failure history, throwing host gate and stale-base gate admit, zero occupancy on claim-read failure), we:scripts/conveyor/fix-claim-store.mjs (strict validation checks truthiness not timestamp validity), we:scripts/conveyor/unsupported-repo.mjs (corrupt store reads as empty queue). Every unreadable input must refuse, not admit.

Also in scope (pre-existing on main): we:scripts/lib/resource-gate.mjs:399 uses Math.max(local reservations, observed claims), which does not preserve their combined occupancy, so overlapping unpublished reservations and sibling claims can launch above the cap. Also we:scripts/lib/ci-heal-reserve.mjs (claim-read failure counts as zero holders; throwing host gate keeps admit:true) and the we:scripts/operations/ci-heal-pr-dispatch.mjs failed accounting writes and empty fix-loop history.

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
