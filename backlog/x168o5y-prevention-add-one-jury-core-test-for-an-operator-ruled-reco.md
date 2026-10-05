---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/guard-bash.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add one jury-core test for an operator-ruled record with an empty stamp. A review lens that asks… (from web-everything/web-everything#3955 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:2437` — Add one jury-core test for an operator-ruled record with an empty stamp. A review lens that asks for a named test for each guarantee in a comment would catch the whole class.
2. `we:scripts/guard-bash.mjs:3096` — Add a guard-bash table test that runs every deny rule against a flag-interleaved `gh` form, ideally with one shared `ghSubcommand` normalizer. The merge and edit arms would benefit from the same normalizer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3955@7e162bba06fccb322b81785c0830440b920abf4b

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
