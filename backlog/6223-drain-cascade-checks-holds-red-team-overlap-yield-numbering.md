---
bornAs: xrdwiud
kind: story
size: 3
status: active
scaffoldedBy: "drain-fastdrain-holds"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Drain cascade checks holds (red-team, overlap-yield, numbering owed) before fresh reads and branch prep

Note: build after #5518, #5492, #5480 and #5462 land (we:scripts/merge-ai-prs.mjs is occupied).

The drain cascade finds holds (red-team-pending, overlap-yield, numbering owed) only after the fresh read, sibling reads and branch preparation, so held PRs still pay for them. About 76% of listed PRs are holds. Check holds first and skip the reads and prep for held PRs. Expected 60-100 min/day of pass time.

## Acceptance

- [A1] **Executable** — vitest run on a cascade test: a held PR triggers no fresh read and no branch preparation; an unheld PR is unchanged. Fails before, passes after.

## Non-goals

- [N1] The holds themselves are not weakened or changed.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
