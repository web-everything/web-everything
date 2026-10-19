---
bornAs: xdow1tl
kind: story
size: 3
status: open
scope: ["we:scripts/backlog.mjs"]
dateOpened: "2026-10-19"
tags: []
---

# Ten duplicate bornAs hashes on main make the card resolver's JIT mapping ambiguous

Ten bornAs hashes appear on two or more cards on main, so the card resolver's just-in-time number mapping cannot tell which card a hash means. Pairs: x2t6cr5 (3201, 3244); x8hzy1m (3660, 3663); xhprieg (3664, 3661); xldrls6 (3662, 3665); xp12dod (4498, 4512); xu2krte (3557, 3544); xzdi27a (3111, 3112). Card 4658 also carries three foreign hashes: x7pj0mw (also 4397), xggb0ep (also 4383), xycb80x (also 4398). Re-hash the later card of each pair through the sanctioned renumber path, then add a check:standards rule that fails on any duplicate bornAs.

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
