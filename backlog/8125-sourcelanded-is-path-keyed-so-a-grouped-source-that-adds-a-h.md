---
bornAs: xar2ztt
kind: story
size: 2
status: open
scope: ["we:scripts/lib/card-group.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# sourceLanded is path-keyed, so a grouped source that adds a hash-keyed card is read as 'not on main' once JIT…

Flow-sim gap R7c-G2, class K12 (identity keyed by location, not content). Failing input: Two ready-to-merge + review:accepted card-only PRs, #A and #B, share an existing card file. #A also adds a new `we:backlog/x9k2m1p-new-card.md` (card-only diff, no `item`, not a couple), so form() accepts it (we:card-group.mjs:1002-1011). Group G with combined PR C. C merges. The drain's post-land numbering (we:scripts/lane-dra… Cited: we:scripts/lib/card-group.mjs:836-861, we:scripts/lib/card-group.mjs:336-364, we:scripts/lib/card-group.mjs:434-438, we:scripts/lib/card-group.mjs:171-184, we:scripts/lib/card-group.mjs:908-913. Soak-break sketch: Fixture: main with we:123-new-card.md (bornAs: x9k2m1p) and NO x9k2m1p-*.md; a source head that adds we:backlog/x9k2m1p-new-card.md with the same body. Action: sourceLanded({ref: main, source, referenceMap: readReferenceMap(main).map}). Assert (fails today): …

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
