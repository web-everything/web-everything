---
kind: story
size: 3
status: active
scaffoldedBy: "drain-fastdrain-holds"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/fast-drain-hold-skip.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-17"
tags: []
---

# Catch-up fast drains skip a PR still held on the same head

Note: build after #5480 lands (we:scripts/lib/enqueue-on-event.mjs and we:scripts/settings/merge-queue.json are occupied).

Catch-up fast drains (enqueue-on-event) each re-run a full listing and compete for the 6 host gh slots, even for PRs held on red-team-pending, overlap-yield or numbering owed. Skip a PR whose last recorded drain outcome, for the SAME head and within drain.fastDrainHeldSkipMinutes (default 10), is one of those holds. Log the reason and the setting source. Expected 40-80 min/day of gh-slot time.

## Acceptance

- [A1] **Executable** — vitest run on the new hold-skip test file: same-head held is skipped; head changed runs; red-team comment event runs; stale record runs. Fails before, passes after.

## Non-goals

- [N1] No new store (reuse the per-PR outcome record); no change to the hold itself.

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
