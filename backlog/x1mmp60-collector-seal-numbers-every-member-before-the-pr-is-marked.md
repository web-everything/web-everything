---
kind: story
size: 3
parent: "x87psvt"
status: open
blockedBy: ["x5nmdnt"]
scope: ["we:scripts/operations/card-batch-seal.mjs", "we:scripts/operations/card-batch-seal-io.mjs", "we:scripts/operations/card-batch-extract.mjs", "we:scripts/operations/__tests__/card-batch-seal.test.mjs", "we:scripts/operations/__tests__/card-batch-seal-io.test.mjs", "we:scripts/operations/__tests__/card-batch-extract.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Collector seal numbers every member before the PR is marked ready

Per decision x5ioz96 fork 5 (statute backlog-ids-numbered-before-publish): add a number-members seal step after record-sealed and before verify, calling the declared numbering operation once over the whole branch so sibling references resolve together. It fails closed: if numbering fails the batch stays held and never reaches ready.

The `number-members` step must record each member's old->new path map in the batch journal. Member attribution in `we:scripts/operations/card-batch-extract.mjs` (the `cardPath` derivation at lines 199-207) must resolve a member by either its admission path or its numbered path, applying the journal map or following the rename with `git diff-tree -M`. Findings citing the numbered path must still be attributed to the original member.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/operations/__tests__/card-batch-seal.test.mjs we:scripts/operations/__tests__/card-batch-seal-io.test.mjs we:scripts/operations/__tests__/card-batch-extract.test.mjs` fails before this item lands and passes after. Planned cases:
  - `seal steps run record-sealed, number-members, verify, remove-hold, ready, label-on-green` (we:scripts/operations/__tests__/card-batch-seal.test.mjs).
  - `numbers all siblings in one pass so cross-references resolve` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — two members that name each other both carry the new numbers.
  - `findings on a numbered member's new path are attributed to that member` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — admit `we:backlog/xabc123-card.md` plus a sibling, number that member to `we:backlog/6500-card.md` at seal, and assert that the batch journal records its old->new path map. Reconstruct the members through `card-batch-extract.mjs`'s production attribution path from the original admission commits and the persisted seal journal, rather than supplying a hand-corrected `cardPath` in the fixture. Run `attributeFindings` with a finding citing `we:backlog/6500-card.md` (use repo-relative paths in the fixture); it must return `extract` for that member, not `hold`, and retain the sibling in `survivors`. Also check that a finding citing its admission path still resolves to the same member.
  - `numbering failure retains the hold and never reaches ready` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs).
  - `seal step changes card text only through the numbering operation` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — with the numbering operation stubbed to rename files only, every member's content is byte-identical after `number-members` except for the lines that operation rewrote; the seal step itself edits no card text.
  - `members are numbered through the batch repo's own operation` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — a batch for a sibling repo calls that repo's declared numbering operation with that repo's checkout, never WE's, and a WE batch calls WE's.
  - `partial numbering output retains the hold` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — the numbering operation exits 0 but numbers 7 of 8 members (one keeps its hash name): the step counts as failed, the batch stays held, and verify and ready never run.
  - `crash after the numbering push and before the head is recorded resumes without head-mismatch` (we:scripts/operations/__tests__/card-batch-seal-io.test.mjs) — fault injection: the numbering commit is on the remote but `headSha` is still the pre-numbering head; the next run adopts the numbered head (or re-records it) and continues to verify, never refusing `head-mismatch` and never numbering twice.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to the numbering operation itself or to the land-time uniqueness check (statute backlog-ids-numbered-before-publish rule 1).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card bodies are rewritten only by the declared numbering operation; the seal step does no text substitution of its own (case `seal step changes card text only through the numbering operation`).
2. **Truncated reads** — numbering output that does not cover every member counts as a failure; the batch stays held (case `partial numbering output retains the hold`).
3. **Shared state files** — the step runs under the seal lease on the collector branch; the rewritten head is recorded before verify runs on it (case `crash after the numbering push and before the head is recorded resumes without head-mismatch`).
4. **Fail closed** — any numbering failure keeps the batch held and never reaches ready (case `numbering failure retains the hold and never reaches ready`).
5. **Identity scoping** — numbers are allocated per repo through the declared operation (case `members are numbered through the batch repo's own operation`).
6. **State over time** — a re-run after a timeout must not renumber (x245i7o's case `timeout during number-members then resume leaves each member numbered exactly once`).
7. **Who wrote it** — the numbering commit is not an admit commit; if the batch is later closed, x5nmdnt surfaces it through the PR link.
