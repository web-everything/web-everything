---
bornAs: xf0q813
kind: story
size: 3
status: resolved
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/lib/card-dedupe.mjs"]
dateOpened: "2026-10-18"
dateResolved: "2026-10-19"
tags: []
---

# Prevention cards stop editing the shared parent card; the parent's "Also raised by" list is derived

Live 2026-10-18: 15 card-only PRs went DIRTY, all on backlog/5360-…md's "Also raised by" list (also 5473, 5605, 5668). Every prevention card appends a line, and JIT numbering at land rewrites the same lines. Fix: each card records `raisedBy` in its own frontmatter; the parent's list is derived at read/render time and never committed. Include a one-time migration of the existing lists.

Scope: the prevention filer (we:scripts/operations/land-prevention-card.mjs, we:scripts/lib/card-dedupe.mjs, grep "Also raised by" in we:scripts/) and the card renderer.

[A1] Executable: a duplicate finding writes raisedBy only to the new card and leaves the parent file byte-identical.
[A1] Executable: the renderer derives the parent's "Also raised by" list from cards whose raisedBy names it.
[A1] Executable: the migration moves existing "Also raised by" lines into raisedBy and is idempotent.

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
