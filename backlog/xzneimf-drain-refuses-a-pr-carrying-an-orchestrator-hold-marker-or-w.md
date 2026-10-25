---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/conveyor/draft-promotion-rule.mjs", "we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Drain refuses a PR carrying an orchestrator hold marker or WEAKENED audit; nothing un-drafts a human-drafted PR

SERIOUS 2026-10-24: #5853 (open-pr refuses PRs over 300 lines) MERGED at 15:09Z although drafted 23:45 ET 10-23 for a WEAKENED audit and a conflict with the ratified size-adds-reviewers-never-refuses decision; a bot un-drafted it and the drain merged it. Same un-draft on #5839 and #5849 (11:36 ET drafted, un-drafted by 12:28 ET). Root cause: draft-promotion-rule promotes green drafts by design; the correct hold is draft plus review-status:draft-withdrawn. Want: drain refuses a PR whose body or comments carry an orchestrator hold marker or WEAKENED audit line; nothing un-drafts a PR a human or orchestrator drafted; enqueue refuses any PR with red-team:blocked and the red-team gate removes ready-to-merge when it blocks; needs-you alert when a held PR gets merged. Related open card 6179.

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
