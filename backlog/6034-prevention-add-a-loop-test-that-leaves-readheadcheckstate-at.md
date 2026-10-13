---
bornAs: xs9t5g8
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/draft-promotion-loop.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/conveyor/__tests__/draft-promotion-loop.test.mjs", "we:scripts/operations/__tests__/promote-draft-pr-dispatch.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Add a loop test that leaves readHeadCheckState at its default and injects only the gh transport,… (from web-everything/web-everything#5146 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5146's review (reviewed head `9e5d3a48c332d7d0c4aca28cb7e752293471eadf`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/draft-promotion-loop.mjs:115` — Add a loop test that leaves `readHeadCheckState` at its default and injects only the `gh` transport, so the real wiring is exercised end to end. More generally, require that any option wired only on the default path has a test through that default.
2. `we:scripts/operations/promote-draft-pr-dispatch.mjs:334` — Add an end-to-end replay test: a draft with an absent merge-gate must promote and then be dispatched a review by `planReconcile`, so a downstream refusal fails the suite. Alternatively, define one shared "required set for the promotion lifecycle" helper used by every consumer.
3. `we:scripts/conveyor/draft-promotion-loop.mjs:117` — Add the default-reader integration test to the automated suite and verify that removing the production forPromotion flag makes it fail.

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
