---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/reconcile-note-comment.mjs", "we:scripts/operations/operator-queue-needs-person.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/operations/needs-you-feed.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# needs-person ask is not bound to a head: a round-cap / ci-heal note about an old head stays on the operator's…

Flow-sim gap R8b-G3, class K6 (check-then-act race with no pin). Failing input: Trusted note 'conveyor - needs your decision' (e.g. ci-heal-exhausted, 3/3) posted at head A; a fixer or the operator then pushes head B; operator has not commented.' 'operator-queue run after the push. Cited: we:scripts/conveyor/reconcile-note-comment.mjs:96-104, we:scripts/operations/operator-queue-needs-person.mjs:5-13, we:scripts/operations/operator-queue.mjs:791-799, we:scripts/operations/needs-you-feed.mjs:80. Soak-break sketch: Fixture: PR comments = [note(ci-heal-exhausted) at t1], commits: head moved at t2>t1, no operator comment. Action: needsPersonRow(repo, {headRefOid:B, comments}). Assert null (note predates the head); fails today (row returned). Contrast: standDownRow lapses …

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
