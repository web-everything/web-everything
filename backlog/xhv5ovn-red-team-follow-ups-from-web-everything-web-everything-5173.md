---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/land-prevention-card.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5173 (head b3f74b842)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5173 (reviewed head `b3f74b842eefe0da97ad3c2e05ddedfb06747fac`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/land-prevention-card.mjs:476` — (failing-input, degraded) Cross-repository prevention cards identify an unrelated WE PR as their source.
   - Scenario: Pass retract={repo:'frontier-ui/frontierui',pr:'42',headSha:&lt;Frontier UI commit&gt;} and successfully batch the card. The new handoff records source.repo='web-everything/web-everything' alongside source.pr='42' and the Frontier UI head. A read-only probe through the production orchestration and actual renderBatchBody emitted 'web-everything/web-everything#42 — Prevention guard (from frontier-ui/frontierui#42)'. The structured provenance and rendered source reference therefore point to the wrong PR. Batch destination and source repository should be represented separately so publication remains in
   - Claude's re-check: The diff hardcodes source.repo to the WE slug while taking pr and head from input.retract. The note even handles retract.repo being a different repo. A cross-repo retract such as frontier-ui#42 therefore records WE#42 with a foreign head SHA, which is wrong provenance.

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
