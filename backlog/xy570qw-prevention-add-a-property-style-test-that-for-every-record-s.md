---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a property-style test that for every record shape, a finding the gate holds as pending is als… (from web-everything/web-everything#3964 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:2297` — Add a property-style test that for every record shape, a finding the gate holds as pending is also in liveReferrals, unless it is dropped for a disabled seat. This is a deterministic parity check between the two views.
2. `we:scripts/lib/jury-core.mjs:2349` — In `findCarriedOperatorRuling`, require the raw trimmed file strings (minus the `:line` suffix) to be exactly equal, or have the IO side assert that the old and new canonical paths are identical. Add a table test with `we:parser.mjs` against `we:a/parser.mjs`. Longer term, add a lint that flags `corroborationPath` use in clearance-granting code.
3. `we:scripts/operations/review-pr-io.mjs:815` — Add one `it` case where `readChangedLines` returns a bare Set. Convention: every fail-closed branch named in a comment gets a negative twin test.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3964@29c3b9c288ce52ac18579d1bdff6098afe3387db

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
