---
bornAs: x9ryzme
kind: story
size: 3
parent: "6268"
status: open
scope: ["we:scripts/lib/needs-you-feed.mjs", "we:scripts/lib/__tests__/needs-you-feed.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# we: operator override slice 4 - needs-you flag for confirmed loosening overrides

Show every confirmed loosening operator override in the needs-you feed, per decision 6268 (we:docs/agent/platform-decisions.md#operator-override-settings-layer), so a guard is never off without the operator seeing it.

## Acceptance

- [A1] **Executable** — `node --test we:scripts/lib/__tests__/needs-you-feed.test.mjs`. Named tests, one per guarantee:
  - `a confirmed loosening override appears in the needs-you feed with its key, expiry and instruction`
  - `a non-loosening override does not appear`
  - `an expired override drops out of the feed`
  - `an unreadable override layer yields no entry and no crash`

## Non-goals

- [N1] Does not change the guard floor or the store; display only.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the operator instruction is shown as escaped text, never rendered as markup.
2. **Truncated reads** — an unreadable layer yields no entries and a logged note.
3. **Shared state files** — n/a: the feed only reads the store.
4. **Fail closed** — a failure to read means the feed omits the entry and logs it, it never hides other entries.
5. **Identity scoping** — n/a: no identity decision is made here.
6. **State over time** — entries drop out of the feed when the override expires.
7. **Who wrote it** — each feed line names the actor and time from the log entry.
