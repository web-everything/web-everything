---
bornAs: x1lxqta
kind: story
size: 2
status: open
scope: ["we:forge-verify-marker.test.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# fix daemon never ci-heals a DRAFT PR with red CI — it only tries draft-promotion and skips ('required checks r

HIGH priority hint. - (2026-10-31 19:47 ET) HIGH: fix daemon never ci-heals a DRAFT PR with red CI — it only tries draft-promotion and skips ('required checks read red, not green'), so #6141 (draft, 1 red test we:forge-verify-marker.test.mjs) sits forever. Fix: draft + own-failure CI red → dispatch ci-heal like a non-draft.   - RETRACTED (2026-10-31 19:58 ET): the 19:47 'fix daemon never ci-heals a DRAFT' card is wrong — reconcile tick does heal drafts (#6141 dispatched 21:11Z/23:55Z; waited on CPU admit at 23:46Z). The 'draft-promotion: skip' line is only the promotion loop. Optional LOW: reword that skip line to say ci-heal owns red drafts.

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
