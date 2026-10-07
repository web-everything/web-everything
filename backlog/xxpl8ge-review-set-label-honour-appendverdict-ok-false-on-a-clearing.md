---
kind: story
size: 2
status: open
scope: ["we:scripts/review-set-label.mjs", "we:scripts/__tests__/review-set-label.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# review-set-label: honour appendVerdict ok:false on a clearing verdict (block the label swap)

Found by the PR 4311 review (ledger plan slice C2). With the dual-write, we:scripts/lib/verdict-ledger.mjs#appendVerdict returns ok:false plus ledgerWriteMiss for a clearing verdict whose git write missed. we:scripts/review-set-label.mjs only logs 'append REFUSED (#3007 shadow)' to stderr and still swaps the PR label, so the F4 promise 'a clearing verdict that missed git does not clear' does not hold on that caller. review-pr-io and merge-ai-prs already honour ok. Make the swap consume the miss for a clearing verdict, and add a contract test per appendVerdict caller (review-set-label, merge-ai-prs, review-pr-io) with a failing gitAppend that asserts no label swap.

Second caller gap (same review round): after a clearing verdict misses git in `dual`, the home row already exists, so the next `review-pr-io` run folds home in `we:scripts/operations/review-pr-io.mjs`, sees the verdict, returns `reconciled: true`, and never retries the git write — the label swap then proceeds. The row needs an "un-mirrored" marker the fold (or the reconcile effect) can see, and `store=git` rows stay invisible to `foldRepo` until the read slice, so each re-run appends a duplicate git row. Also open: no backfill between `home` and `dual`/`git` when the store setting is switched.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/__tests__/review-set-label.test.mjs` fails before this lands and passes after: with `appendVerdict` returning `ok:false` + `ledgerWriteMiss` for a clearing target, `review-set-label` makes no `gh pr edit` label swap and exits non-zero; a holding target still swaps.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the change reads only the typed `ok`/`ledgerWriteMiss` result, no free text.
2. **Truncated reads** — n/a: no read path changes.
3. **Shared state files** — the home row already exists when the git write misses, so a retry must not append a duplicate row (assert one home row after a refused swap and a retry).
4. **Fail closed** — a clearing verdict whose ledger write missed refuses the swap; a holding verdict still holds.
5. **Identity scoping** — n/a: the record's repo/PR are unchanged.
6. **State over time** — the ledger is behind the label after a refused swap; the operator retry path must clear it once the transport is reachable.
7. **Who wrote it** — n/a: the caller and actor fields are unchanged.
