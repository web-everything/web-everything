---
bornAs: xu36zj7
kind: story
size: 2
status: open
scope: ["we:scripts/operations/graduate-chain.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5840 (head 926dd76f3)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5840 (reviewed head `926dd76f3b5aff3f4d9927ab8ec654e8f521cb63`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/graduate-chain.mjs:105` — (edge-case, degraded) Merge preflight can reject commits that cherry-pick cleanly
   - Scenario: Construct main O, source O→A→B, and stack parent O→A→C. Let O contain we:f.mjs with value=0, A change it to value=1, C change it to value=2, and B only add we:g.mjs. Run --source=lane/source --stack-on=&lt;parent&gt;. Commit selection correctly excludes A and selects only B, which applies cleanly over C. However, preflight merges C and B using O as the forced merge base, producing a conflict on we:f.mjs and stopping before cherry-pick. Real Git merge-file probes confirmed the forced-base conflict and the clean result when applying B's unchanged we:f.mjs over C. Preflight must simulate the selected commits rathe
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
