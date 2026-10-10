---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xbxahvf-pr-limit-opening-a-card-only-pr-is-exempt-from-the-open-pr-c.md", "we:backlog/x9dscc7-card-batch-a-sealing-batch-must-not-block-new-filings-rotate.md", "we:backlog/xfyhz2z-builder-batches-small-same-area-cards-into-one-build-pr-buil.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — A check:standards rule verifying that every new backlog card contains ## Risks and ## Test plan s… (from web-everything/web-everything#4781 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xbxahvf-pr-limit-opening-a-card-only-pr-is-exempt-from-the-open-pr-c.md` — A check:standards rule verifying that every new backlog card contains ## Risks and ## Test plan sections that map each behavioral constraint to a named test.
2. `we:backlog/x9dscc7-card-batch-a-sealing-batch-must-not-block-new-filings-rotate.md` — A check:standards rule verifying that every new backlog card contains ## Risks and ## Test plan sections that map each behavioral constraint to a named test.
3. `we:backlog/xfyhz2z-builder-batches-small-same-area-cards-into-one-build-pr-buil.md` — A check:standards rule verifying that every new backlog card contains ## Risks and ## Test plan sections that map each behavioral constraint to a named test.
4. `we:backlog/x9dscc7-card-batch-a-sealing-batch-must-not-block-new-filings-rotate.md` — A commit-hook or CI rule rejecting PRs that modify multiple disjoint backlog files when the PR title asserts a single-card admission goal.
5. `we:backlog/x9dscc7-card-batch-a-sealing-batch-must-not-block-new-filings-rotate.md` — A pre-merge hook that enforces a 1:1 mapping between the PR's stated card goal and the added backlog files.
6. `we:backlog/xfyhz2z-builder-batches-small-same-area-cards-into-one-build-pr-buil.md` — A pre-merge hook that enforces a 1:1 mapping between the PR's stated card goal and the added backlog files.
7. `we:backlog/xbxahvf-pr-limit-opening-a-card-only-pr-is-exempt-from-the-open-pr-c.md` — A check:standards rule requiring 'Risks' and 'Test plan' headings in all new backlog cards.
8. `we:backlog/x9dscc7-card-batch-a-sealing-batch-must-not-block-new-filings-rotate.md` — A check:standards rule requiring 'Risks' and 'Test plan' headings in all new backlog cards.
9. `we:backlog/xfyhz2z-builder-batches-small-same-area-cards-into-one-build-pr-buil.md` — A check:standards rule requiring 'Risks' and 'Test plan' headings in all new backlog cards.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4781@88b49f731cb251f8c1958510a7484967c146e425

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
