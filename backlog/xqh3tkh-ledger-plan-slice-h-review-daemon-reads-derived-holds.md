---
kind: story
size: 3
parent: "2405"
status: active
scaffoldedBy: "ledger-slice-h"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/conveyor/review-hold-ledger-shadow.mjs", "we:scripts/conveyor/__tests__/review-hold-ledger-shadow.test.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Ledger plan slice H: review daemon reads derived holds (shadow per family)

The review daemon's hold/pause decisions (referral pause, same-head cap, block-ruled fix, ruling-needed) are also computed by derivePrState over the shared ledger store, behind verdictLedger.readSource.<family> = labels|both|ledger (default both = shadow: decide on today's source, journal ledger disagreements with a cause). A family flipped to ledger decides from the ledger (unreadable holds). Done when: vitest replays #3771/#3988 show a second review on an unchanged head refused in ledger mode with the reason recorded, and the live daemon journals N agreements and any disagreements with cause.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/review-hold-ledger-shadow.test.mjs we:scripts/conveyor/__tests__/reconcile-pass.test.mjs`: the #3771 and #3988 replays (ledger rows: one completed `review-run` on an unchanged head, then a second tick) refuse the second review in `ledger` mode with the reason recorded; in the default `both` mode the daemon's decision is byte-identical to `labels` and each disagreement is journaled once with its cause; an unreadable store holds in `ledger` mode and journals `ledger-unreadable` in `both`.
2. **Live** — the running review daemon logs a per-tick `ledger-shadow` line and appends journal rows for real open PRs: N agreements and every disagreement with its cause.
3. Must: a ledger read error or a derive crash never changes a `labels`/`both` decision and never throws out of the tick (refuse = keep today's decision; in `ledger` mode refuse = hold).

## Edge cases this change must handle

1. **Untrusted text** — ledger rows are validated by `derivePrState` (invalid row = `ledger-unreadable` hold); the journal stores codes and counts, never PR comment text.
2. **Truncated reads** — the store read is all-or-nothing (`unreadable`, never empty); a PR with no rows is journaled with cause `no-ledger-rows`, never as a ledger clear.
3. **Shared state files** — the journal is append-only JSONL; one writer (the daemon holds its runner lease); dedupe state is per-process memory, so a restart re-journals once.
4. **Fail closed** — `ledger` mode with an unreadable ledger or a crashed derive holds the review; `both`/`labels` keep today's decision.
5. **Identity scoping** — derive is scoped by repo + PR number; the head is the live `headRefOid`.
6. **State over time** — a journal row is written only when a PR/family's (head, old, ledger, cause) signature changes, not every tick.
7. **Who wrote it** — n/a: this slice reads rows other writers appended; it writes no ledger rows and no labels.

## Placement note

The hook is the reconcile pass (`enrichPrsWithLedgerHolds`, right after `enrichReferralHolds`), the one place both the review daemon and the fix daemon take these hold decisions, so a flipped family reads the same in both (plan R2). `we:skills-src/conveyor/review-daemon.mjs` and `we:scripts/conveyor/review-referral-hold.mjs` were held by PRs #4453 / #4441 and are not needed.

## Follow-up

- Declare `verdictLedger.readSource` (families `referralHold`, `sameHeadHold`, `blockRuled`, `rulingNeeded`; default `both`) in `we:config/platformDefaults.ts` once lane `ledger-shared-readers` releases that file. Until then the env mirror in `we:scripts/conveyor/review-hold-ledger-shadow.mjs` is the only declaration.
