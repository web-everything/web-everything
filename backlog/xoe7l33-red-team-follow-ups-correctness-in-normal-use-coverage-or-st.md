---
kind: story
size: 2
status: open
scope: ["we:backlog/8657-block-credential-state-exfiltration-through-confined-agy-pat.md"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7291 (head cc5f7a4e4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7291 (reviewed head `cc5f7a4e4a70004a8735eea2a2c8b2e7dfaad5f6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/8657-block-credential-state-exfiltration-through-confined-agy-pat.md:24` — (failing-input, degraded) Update sibling references after re-filing the confinement cards
   - Scenario: Following this card's deferred-work references to #8603 and #8610 cannot locate either card: neither ID exists in this checkout. Their replacements are #8678 and #8649. Related references in #8665 and #8678 also still name #8605 instead of #8657. Rewrite these sibling references to the replacement IDs so readers can find the separately tracked security work.
   - Class: correctness-in-normal-use (basis: A read-only filesystem probe confirmed that IDs 8603, 8605 and 8610 have no backlog files, while replacement cards 8678, 8657 and 8649 exist. The new cards retain the discarded numbers in operational cross-references.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

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
