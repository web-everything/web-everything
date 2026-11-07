---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/operator-queue.mjs", "we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A human-only (workflow-file) approved PR is hidden from every text/feed surface when the main-CI probe or the…

Flow-sim gap R8b-G6, class K15 (detector or report false negative). Failing input: PR with review:accepted + ready-to-merge, all checks green, MERGEABLE, red team clear on head, touching .github/workflows/*; readMainCi throws (gh/probe failure) or readNetDiff returns an error (e.g. repoProfile(repo).checkoutPath undefined -> 'no checkout to read the pinned diff from', we:merge-queue-enqueue.mjs:251).' 'operat… Cited: we:scripts/operations/operator-queue.mjs:766-772, we:scripts/operations/operator-queue.mjs:773-779, we:scripts/operations/operator-queue.mjs:743-745, we:scripts/operations/operator-queue.mjs:861-869, we:scripts/operations/needs-you-feed.mjs:79. Soak-break sketch: Fixture: operator-queue main() with one approved workflow-touching PR, readMainCi injected to throw. Action: run in text mode and capture stdout/exitCode. Assert output contains 'UNKNOWN' or the pending reason (or exitCode 1 / report.incomplete); fails today …

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
