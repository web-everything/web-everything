---
bornAs: x0h3pe4
kind: story
size: 2
status: open
scope: ["we:scripts/backlog/scaffold.mjs", "we:scripts/operations/scaffold.mjs", "we:scripts/backlog.mjs", "we:scripts/held-cards.mjs", "we:scripts/held-cards-io.mjs", "we:scripts/operations/explore-io.mjs", "we:scripts/conveyor/prepare-failure-policy.mjs", "we:scripts/conveyor/soak/breaks/prevention-card-lands-in-daemon-clone.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# file-item keeps --size for decisions and refuses it where a kind can never be sized

we:scripts/backlog/scaffold.mjs renderItem silently dropped --size for every kind but story/epic, so a sized decision filed via file-item was born unsized (found filing PR #4460). Fix: emit size for every sizable kind; refuse loudly (planScaffold + we:scripts/backlog.mjs scaffold) for kinds that are never sized (task, feature) and for a non-numeric size. Never silently drop a passed flag.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
