---
bornAs: x0lckod
kind: story
size: 2
parent: "x5wqxb3"
status: open
blockedBy: ["xukmjgl"]
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/saved-red-team-provenance.mjs", "we:scripts/lib/review-run-index.mjs", "we:scripts/conveyor/review-referral-hold.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Slice 3: retire the full review-run scan to a missing-index fallback only

Epic x5wqxb3. Delete the shadow comparison. The full scan stays only for a missing or unreadable index directory. Optionally move review-referral-hold's own mtime/size projection cache (same race class) onto the index. Delivery mode: pr.

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
