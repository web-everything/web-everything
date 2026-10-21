---
kind: story
size: 5
parent: "x87psvt"
status: open
scope: ["we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector coordinator retires a stuck sealed batch from GitHub truth

Priority: top (unblocking). Live: the prevention collector has been stuck since 2026-10-14. Batch 9 (PR 5272) merged but its state file kept sealedAt at seal step ready, so admission refuses every card with batch-sealed and the filer spools it: 327 cards spooled at 2026-10-18 08:06 ET. Fix: on the next admission, the coordinator reads the sealed batch's PR state on GitHub (GitHub is the truth) and acts under the existing per-kind lease. Each PR state has its own row:

| PR state on GitHub | What happens to the state file | What happens to the members |
| --- | --- | --- |
| merged | retired; the next admission opens a fresh batch | nothing: the merge landed them |
| closed, not merged | retired only after every member is carried | each member that has not landed is re-admitted into the fresh batch, with the card bytes read from its own admit commit |
| unreadable (API error, missing PR number) | stays sealed and held | untouched |

A member "has not landed" when its card path is not on main and its idemKey is not on main. Two kinds of member are never carried: one already extracted to its own PR (statute rule 4: an extracted card is never re-queued into a collector), and one already on main. If any member's bytes cannot be read (its admit commit is gone), the batch stays sealed and held with the reason `closed-unmerged-member-unrecoverable`, naming the member, and surfaces as needs-you. A member is never dropped silently.

A deliberate operator close is carried forward too. Closing the whole batch is not the way to reject cards: decision x5ioz96 fork 4 rejected that as option (c), because it sinks good cards for one bad one. A bad card is rejected through extraction, so the batch's other cards are always meant to land.

Proof required: before/after on the live 327-card spool draining into a fresh batch. Operator 2026-10-18 verbatim: All ok.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-io.test.mjs` fails before this item lands and passes after. Planned cases:
  - `retires a sealed state whose PR merged on the next admission` (we:scripts/operations/__tests__/card-batch.test.mjs) — admission returns `admit` into a fresh batchRef, never `batch-sealed`.
  - `closed-unmerged batch carries unlanded members into the fresh batch` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — every unlanded member's card is a member of the new batch, with the same bytes and idemKey, and the old state is retired.
  - `closed-unmerged batch never carries an extracted or landed member` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — a member with an extraction record and a member whose card is on main are both absent from the new batch.
  - `closed-unmerged batch with an unreadable member stays sealed and held` (we:scripts/operations/__tests__/card-batch-io.test.mjs) — the state keeps sealedAt, the held reason is `closed-unmerged-member-unrecoverable`, and the member is named.
  - `unreadable PR state stays sealed and held` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — no retirement, no member change.
  - `retirement is refused while another owner holds the lease` (we:scripts/operations/__tests__/card-batch.test.mjs) — a concurrent admission gets `lease-held`, and no card lands on the retired batch.
- [A2] **Live** — the 327-card prevention spool drains into a fresh batch: before/after spool count on the real host.

## Non-goals

- [N1] The seal timeout itself (x245i7o), numbering at seal (x1mmp60) and the unextractable-finding age escape (xf1z2w3) are their own slices.
- [N2] No new setting: retirement and carrying are unconditional.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the PR state and member metadata come from GitHub and git; an unknown PR state is treated as unreadable (fail closed).
2. **Truncated reads** — a failed or partial GitHub read is unreadable, never "closed"; the batch stays sealed and held.
3. **Shared state files** — retirement and carrying run under the existing per-kind lease with the expected-head check; a concurrent admission is refused `lease-held`.
4. **Fail closed** — an unreadable PR state, or an unrecoverable member of a closed-unmerged batch, keeps the batch sealed and held, never retires.
5. **Identity scoping** — state is keyed by repo and kind; a carried member keeps its own idemKey, so a re-file dedupes against it.
6. **State over time** — the three PR-state rows above, one assertion each in [A1]; a crash between carrying and retiring resumes from the members already carried (dedupe by idemKey).
7. **Who wrote it** — n/a: only the coordinator writes the state file and the collector branch.
