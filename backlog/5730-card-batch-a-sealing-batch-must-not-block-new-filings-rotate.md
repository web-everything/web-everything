---
bornAs: x9dscc7
kind: story
size: 3
parent: "4703"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Card batch: a sealing batch must not block new filings (rotate the active slot at seal)

Found while building batch filing (2026-10-10). The seal worker (we:scripts/operations/card-batch-seal-io.mjs publishBatch) holds the per-kind coordinator lease for its whole run, including the sealed-head verify (up to 70 minutes), and the active state slot is only retired after label-on-green. Every filing that arrives meanwhile gets lease-held from we:scripts/operations/card-batch-io.mjs admitCard, outlasts the bounded retry in we:scripts/operations/card-batch-file.mjs, and falls back to its own PR, so each seal leaks one-PR-per-card filings. Fix: at the record-sealed step, move the sealing generation to the sealed archive and hand the active slot to the next sequence before verify, so admissions open batch n+1 while batch n verifies.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- <test>` over we:scripts/operations/__tests__/card-batch-seal-io.test.mjs (strip the `we:` prefix to execute) passes with a new case: while batch 1 is in its verify step, an admission succeeds onto `lane/card-batch-filing-2` instead of returning lease-held.
- [A2] **Must (refuse on error)** — a seal that fails after rotation leaves batch 1 held in the archive with its reason; batch 2 is unaffected and no card is moved between batches.
- [A3] **Must** — the age-seal tick and extraction still find batch 1 in the archive by its PR.

## Non-goals

- [N1] Changing the seal steps themselves (verify, hold removal, ready, label-on-green).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input; state files are written by the coordinator only.
2. **Truncated reads** — an unreadable archive entry keeps the active slot unrotated (today's behaviour) and reports the error.
3. **Shared state files** — rotation happens under the lease with atomic renames, the same way retire does today.
4. **Fail closed** — if rotation cannot complete, the seal keeps the lease as today, so filings fall back to their own PR and no card is lost.
5. **Identity scoping** — the archive key stays repo + sequence + kind.
6. **State over time** — a crash between archive write and slot handoff is resumed by the next seal run from the archived generation.
7. **Who wrote it** — only the seal worker rotates; producers only admit.
