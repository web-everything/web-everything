---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6188"
dateScaffolded: "2026-11-02"
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/ruling-ledger.mjs", "we:scripts/operations/record-referral-ruling.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Legacy-owner operator block hidden by exact repo equality in the review sink, ruling ledger and ruling recorder

PR 6188 made `we:scripts/lib/jury-core.mjs` see an operator `block` written under a repo's legacy owner spelling (it never adopts the record's spelling). Three consumers still compare `o.repo === record.repo` exactly and so miss such a block: the carry guard and drop-seat guard in `we:scripts/operations/review-pr-io.mjs`, the settled-by-operator test in `we:scripts/lib/ruling-ledger.mjs`, and the backed-carry test in `we:scripts/operations/record-referral-ruling.mjs`. Each can persist a carry or retire a finding over a standing block.

## Acceptance

- [A1] **Executable** — a named test per site builds a thread with a clearance spelled as the record and a later legacy-owner block on the same (head, run, key), and asserts the sink persists no carry, the ledger does not treat the carry as settled, and the drop guard does not retire the finding. Fails before, passes after.
- [A2] **Must** — a block under the legacy spelling is matched by canonical repo, a clearance only by exact spelling (reuse the one definition in `we:scripts/lib/jury-core.mjs`, do not copy it).
- [A3] **Must** — an unreadable legacy block fails closed (nothing carries past it); other-PR and unrelated-finding blocks do not hold.

## Non-goals

- [N1] Changing which spelling a clearance is adopted under; that stays in `readOperatorRulings`.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new text is parsed; only an existing repo slug comparison.
2. **Truncated reads** — n/a: reads the already-fetched thread.
3. **Shared state files** — n/a: no state file is written by the comparison.
4. **Fail closed** — an unreadable legacy block holds the finding (A3).
5. **Identity scoping** — block matches by canonical repo, same PR, same (head, run, key); clearance by exact repo.
6. **State over time** — thread order decides: only a block later than the clearance withdraws it.
7. **Who wrote it** — rulings are already author-checked by `parseOperatorRulingComment`; unchanged.
