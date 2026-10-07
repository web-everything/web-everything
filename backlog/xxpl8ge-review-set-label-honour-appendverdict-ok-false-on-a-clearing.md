---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/verdict-ledger.mjs", "we:scripts/lib/__tests__/verdict-ledger.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# verdict ledger: backfill between home and dual/git when the store setting is switched

Found by the PR 4311 review (ledger plan slice C2). The two caller gaps the review first listed here were fixed IN that PR on the operator's ruling (2026-10-07, "Fix"):

- `we:scripts/review-set-label.mjs` now consumes a `ledgerWriteMiss` for a clearing verdict (no label swap, non-zero exit; a holding target still swaps), covered in `we:scripts/__tests__/review-set-label.test.mjs`.
- `appendVerdict` writes a clearing verdict to git FIRST and to home only after git succeeded, so a miss leaves no home row for `review-pr-io`'s fold to mistake for "already decided"; the next run retries cleanly. Covered in `we:scripts/lib/__tests__/verdict-ledger.test.mjs` and `we:scripts/operations/__tests__/review-pr-io.test.mjs`.

What stays open: there is no backfill between the stores when `verdictLedger.store` is switched. Rows written while the store was `home` are not in git after a switch to `dual`/`git`, and `git`-only rows stay invisible to `foldRepo` until the read slice lands. Build a one-shot, idempotent backfill (home → git, keyed by repo + PR + `at` + verdict so a re-run appends nothing twice) and run it as part of the store switch.

Two more gaps the PR 4311 self-review named, both outside that PR's scope, to build here:

- `we:scripts/operations/record-referral-ruling-io.mjs` (`appendLedgerEventsHome`) writes ruling and send-back events to the HOME file only, so a clearing ruling (`card`, `not-real`) clears and posts without ever reaching git. It needs the same git-first ordering for clearing events once `appendLedgerRows` is event-capable.
- The GitHub Actions applier (`we:.github/workflows/apply-review-request.yml`, `contents: read`) cannot push, so on a runner the git board is deliberately not auto-resolved and verdicts it applies stay home-only (ephemeral). Give the applier a path to the ledger (a write token, or the apply step staging the row on the transport branch) so its clearing verdicts reach git too.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/verdict-ledger.test.mjs` fails before this lands and passes after: with rows only in the home ledger, the backfill appends each to git once, and a second run appends none.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — rows are re-validated through `serializeVerdictRecord` before they are pushed; an invalid home line is skipped and counted, never pushed.
2. **Truncated reads** — an unreadable git ledger (`readLedgerFromGit` status `unreadable`) aborts the backfill; it never treats "unreadable" as "empty" and re-pushes everything.
3. **Shared state files** — the dedupe key (repo + PR + `at` + verdict) makes a concurrent or repeated run idempotent; the push uses the existing bounded-retry append.
4. **Fail closed** — a backfill miss is loud and changes no verdict; nothing clears because of it.
5. **Identity scoping** — rows are matched per repo; one repo's backfill never reads another repo's home file.
6. **State over time** — running the backfill after rows were already dual-written appends nothing.
7. **Who wrote it** — n/a: the original `actor` and `source` fields are copied unchanged.
