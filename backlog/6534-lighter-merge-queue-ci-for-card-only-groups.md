---
bornAs: xs2e277
kind: decision
status: open
scope: ["we:.github/workflows/", "we:scripts/"]
dateOpened: "2026-10-19"
tags: []
---

# Lighter merge-queue CI for card-only groups

Evidence (2026-10-19): card PRs land about 2/hour because each waits for the full merge-queue CI (20-30 min), and the drain may queue only one card PR at a time while they share card files. Options: (a) merge queue runs only the card checks (standards, backlog-ids, check:standards card rules) when the group's net diff is backlog/-only, full shards otherwise; (b) keep full CI; (c) a separate card-only queue lane. Guards: required-check names must stay satisfied (skip-with-success job for non-relevant shards); net-diff detection must use git, not GitHub's file list (GitHub misreports, see #5602); a mixed group always gets the full CI. Related: #5715 (xf0q813), xym8nt4 (post-approval grouping), xugqjw1 (review stringency).

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
