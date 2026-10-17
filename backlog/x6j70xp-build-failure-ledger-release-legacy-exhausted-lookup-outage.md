---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/build-dispatch-failures.mjs", "we:scripts/conveyor/retry-backoff.mjs", "we:scripts/conveyor/__tests__/dispatch-retry-backoff.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Build failure ledger: release legacy exhausted lookup-outage records

PR #5453 made a failed origin/main card lookup (reason 'build card lookup unavailable') clone-wide: it is no longer charged to the card. But a ledger record written BEFORE that upgrade still carries reasonCode 'dispatch-failed' with exhausted=true, and we:scripts/conveyor/build-dispatch-failures.mjs#listBuildBackoffs filters on the STORED reasonCode, so the card stays withheld after the outage clears until an operator rearms it. Red-team break confirmed 2026-10-17 05:09Z on PR #5453; operator ruled it a follow-up card. Fix: classify the stored reason text again on read (or migrate once) so a legacy lookup-outage record is treated as clone-wide and never withholds; add a regression with a pre-upgrade record.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/dispatch-retry-backoff.test.mjs`: a new case seeds a pre-upgrade record (`reason: 'build card lookup unavailable'`, `reasonCode: 'dispatch-failed'`, `attempts: 6`, `exhausted: true`) and asserts `listBuildBackoffs` no longer withholds it. Red before, green after.
- [A2] **Must** — a legacy record whose stored reason is any OTHER code stays withheld exactly as before (only a clone-wide reason is released).

## Non-goals

- [N1] Does not change how new lookup outages are classified (PR #5453 already makes them clone-wide), and does not rearm any other exhausted record.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the stored reason is redacted child output; classify it with the same anchored pattern in we:scripts/conveyor/retry-backoff.mjs, never a substring match.
2. **Truncated reads** — the stored reason is capped at 400 chars; the lookup-outage reason is short and exact, so a cut reason never matches (stays withheld, fail-safe).
3. **Shared state files** — a one-time migration writes through the ledger's atomic temp-file rename; reclassifying on read writes nothing.
4. **Fail closed** — an unparseable or unknown record keeps today's behaviour (withheld if exhausted).
5. **Identity scoping** — per card number, same as every ledger record.
6. **State over time** — covers records written before PR #5453 and after; a record written after already carries the clone-wide code and is never persisted.
7. **Who wrote it** — only the build-dispatch daemon writes this ledger; n/a for actor checks.
