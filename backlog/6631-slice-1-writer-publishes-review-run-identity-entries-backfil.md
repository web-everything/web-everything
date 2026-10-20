---
bornAs: xbyg4e4
kind: story
size: 5
parent: "6629"
status: open
blockedBy: ["6630"]
scope: ["we:scripts/operations/run-store.mjs", "we:scripts/lib/review-run-index.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/__tests__/review-run-index.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 1: writer publishes review-run identity entries, backfill, and a shadow indexed reader

Epic 6629. writeRun publishes a per-run identity entry (claim via temp+link, fsynced, before the record's first rename). A one-shot backfill indexes existing review-pr records. A shadow indexed reader runs beside the full scan in readDrainRedTeamEvidence and verifySavedRedTeamProvenance: the full-scan answer stays authoritative, and each pass logs mismatches, unindexed count and timing. Shadow errors are isolated. Proof: live per-call ms and zero mismatches across every ready PR. Delivery mode: shadow.

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
