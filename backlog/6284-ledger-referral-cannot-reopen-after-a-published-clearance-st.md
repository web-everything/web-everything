---
bornAs: x0nzrqx
kind: story
size: 3
status: active
scaffoldedBy: "fix-5550"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/lib/pr-state/referrals.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Ledger referral cannot reopen after a published clearance stops counting in the thread

The mandatory-referral sink in review-pr-io publishes a `not-real`/`card` ruling row once the PR thread counts that clearance. If the clearance later stops counting there (a carry withdrawn at read time, a `card` whose backlog file becomes unreadable), the thread holds the finding pending again, but the sink skips pending keys and writes nothing. The ledger key stays sticky `ruled`, and a later referral cannot reopen it. So the label mirror shows no `advisory:ruling-needed` while the thread gate still holds the PR. This is not a merge risk, because the gate reads the thread. Found by the PR #5550 round-3 self-review (note 6).

## Acceptance

- [A1] **Executable** — a `review-pr-io` test: publish a counted `card` ruling, make the card unreadable, re-run the sink, and expect `deriveReferrals` to report the key `open`. It fails today.

## Non-goals

- [N1] It does not change how the thread gate itself counts rulings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the rows carry hashed keys only.
2. **Truncated reads** — reopen only from a complete, pinned thread read, never a partial one.
3. **Shared state files** — reopen rows need stable ids, so a replay does not stack them.
4. **Fail closed** — when unsure, leave the key open (asks for a ruling), never cleared.
5. **Identity scoping** — scope by the same hashed finding key the referral row uses.
6. **State over time** — a reopen followed by a new ruling must end on the new ruling.
7. **Who wrote it** — only review-pr reopen rows count, matched on source as well as channel.
