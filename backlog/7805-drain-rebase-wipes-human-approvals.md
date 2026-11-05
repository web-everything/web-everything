---
bornAs: xhpfc8p
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Drain rebase wipes human approvals

HIGH priority hint. - (2026-10-28 15:54 ET, HIGH) Drain rebase wipes human approvals: after main went green the drain rebased approved #6003 (→c44bc9f0ee) and #5912 (→53e23b5857) onto main ('drain: rebase … onto origin/main, drop …'), which reset review:accepted → review:pending, so the operator must approve a THIRD/second time. Carry the clear-human approval across a drain rebase when the net diff vs main is unchanged (patch-id / the existing reviewed-diff marker) — and never rebase an accepted, human-only PR just to refresh it unless it conflicts.

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
