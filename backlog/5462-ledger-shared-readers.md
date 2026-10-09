---
bornAs: x7b0be5
kind: story
size: 5
parent: "2405"
status: open
dateOpened: "2026-10-08"
tags: []
---

# Ledger readers read the shared store; async idempotent store contract (ledger-shared-readers)

Ledger product review D2/D4 (ruled 2026-10-08): the checker, G1 label-mirror report, pr-status and the `verdict-ledger show`/`shadow-agreement` CLI read the store chosen by verdictLedger.readStore (default git branch ops/review-requests; home = offline fallback that declares not-shared) through the #4401 registry instead of the machine-local home file. Store contract becomes async (append/read return promises), append is idempotent by event id, each store declares its single-writer guarantee and shared flag; conformance suite updated. A failed read stays unreadable, never empty. Labels remain merge authority; merge gate and drain untouched. Done when: conformance passes for home+git async; checker and G1 report run from a lane show git-store rows the home file lacks.

## Done when

1. **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/verdict-ledger-store.test.mjs we:scripts/lib/__tests__/verdict-ledger.test.mjs we:scripts/__tests__/review-ledger-check.test.mjs we:scripts/conveyor/__tests__/pr-label-mirror.test.mjs` passes: the conformance suite runs async for home and git (idempotent append, `singleWriter` declared, unreadable never empty), and a row written to git only is read by the git reader and not by the home reader.
2. **Live** — from a lane, `node we:scripts/lib/verdict-ledger.mjs show --repo=web-everything/web-everything --json` and `node we:scripts/review-ledger-check.mjs --json --no-record` read the git store (`store.name: git`, `shared: true`) and see a row written from another checkout with its own ledger home, which the home file lacks.

Not in this card (follow-ups): review-pr's two reads (`priorRoundsFor` in the sync read step, and the record sink's "already decided" fold) stay on the home file — moving them needs `we:scripts/operations/review-pr.mjs`'s read step to await and a review-daemon edge. The 6 writers stay sync (`appendVerdict`); `appendVerdictAsync` exists for the hosted store. Git holds only rows since dual-write began (2026-10-08); a one-time idempotent home-to-git backfill closes that gap.

## Edge cases this change must handle

1. **Untrusted text** — ledger rows are parsed by the tolerant validator; an invalid `id` refuses the row; error text is first-line, capped.
2. **Truncated reads** — a store read that fails (fetch error, no board, unknown store) is `unreadable`; the checker exits 2 and scores nothing, the mirror plans nothing.
3. **Shared state files** — git append dedupes against the tip each push retry races; home dedupes under the file lock.
4. **Fail closed** — no silent fallback to home on a git read failure; the F4 write-miss posture is unchanged and shared by the sync and async writers.
5. **Identity scoping** — rows answer only for the repo they carry; event id = explicit `id` or sha256 of the normalized row (lock flag excluded).
6. **State over time** — legacy rows without `id` hash to the same id as their re-stamped copies, so a backfill or retry never duplicates.
7. **Who wrote it** — `writer`/`actor` stay on every row and are part of the event id; the store descriptor states whether rows from other machines are visible (`shared`).
