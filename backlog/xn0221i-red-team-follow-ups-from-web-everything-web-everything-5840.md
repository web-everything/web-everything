---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/graduate-chain.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5840 (head 75d36e1b1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5840 (reviewed head `75d36e1b1759e5f40cfa7833cbeae04ef9254303`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/graduate-chain.mjs:78` — (edge-case, degraded) Concurrent graduations exceed the caller cap
   - Scenario: Start with three open PRs by one caller and callerMax=4. Start two graduations with distinct purposes; let both read the count before either publishes. Both pass admission and subsequently open PRs, leaving five. A deterministic interleaving probe of runGraduateChain produced read(3), read(3), open(4), open(5), with both results reporting ok:true. There is no reservation or caller-cap recheck at publication. Admission must reserve capacity or serialize the count-and-publication sequence.
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
