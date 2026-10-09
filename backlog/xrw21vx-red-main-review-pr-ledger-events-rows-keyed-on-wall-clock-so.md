---
kind: story
size: 2
status: active
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-08"
dateStarted: "2026-10-08"
tags: []
---

# Red main: review-pr ledger-events rows keyed on wall-clock, so same-ms runs collapse and replays double-count

review-pr-io LEDGER_EVENTS sink builds rows whose event id is the sha256 of the whole row including at (ms). Since #x7b0be5 made home append idempotent by event id, three review-run rows written in one millisecond hash equal and collapse to one (CI flake: expected 3 rows, got 2). The effect is declared idempotent:true but the sink is not: a replay writes a fresh at, so a second row. Fix: stamp each row's id from the effect key (ctx.key) plus row type, so one effect = one row across replays and distinct runs never collide.

## Done when

1. **Executable** — a probe calling the LEDGER_EVENTS sink twice: the same effect key replayed 5ms apart yields 1 review-run row (main today: 2), and two distinct run keys in one frozen millisecond yield 2 rows (main today: 1). Plus `npm run test:unit -- we:scripts/operations/__tests__/review-pr-io.test.mjs` passes with 0 failures over 20 repeats (main today: 1 of 10 fails locally; about 4 of 7 main CI runs on 2026-10-08).

## Evidence (2026-10-08, main 0a2601d0e)

- CI main run 37859314117: `a #3988 replay: 3 runs on one head yield 3 review-run rows` → expected length 3, got 2.
- Local: 1/10 failures of `-t "3988 replay"`.
- Probe on main: same-effect replay → 2 rows (want 1); two runs, same ms → 1 row (want 2).
- Cause: `ledgerEventId` (we:scripts/lib/verdict-ledger.mjs, from #4498 / b40d36a9f) hashes the whole row including `at`; the sink stamps `at = new Date()` and ignores `ctx.key`.
- Blocked on scope: PR #4524 holds both files and carries a test-only 3ms sleep for this test, which hides the code bug.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: id is derived from the executor's own effect key, hashed.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — home ledger append is already lock + id-deduped; the fix only supplies the id.
4. **Fail closed** — no ctx.key → fall back to a fresh random id (one call = one row), never a content hash that could merge runs.
5. **Identity scoping** — id = sha256(ctx.key + row type), so referral and review-run rows of one effect stay distinct.
6. **State over time** — a replay of the same effect after a crash re-sends the same id and is deduped.
7. **Who wrote it** — unchanged: writer/session/source fields still stamped by buildLedgerEvent.
