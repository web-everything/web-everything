---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/lib/__tests__/jury-core.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a replay or property test over real multi-finding records asserting that no findingId spans t… (from web-everything/web-everything#4069 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/jury-core.mjs:560` — Add a replay or property test over real multi-finding records asserting that no findingId spans two same-head referrals with different normSummary, or have 76b's carry rule require both claim and hunk equality.
2. `we:scripts/lib/jury-core.mjs:560` — Before 76b's carry rule lands, add a test with two different claims that share a long generic quote and assert they get separate ids. Alternatively, require the anchor to also share a normalized claim token or a line number within the hunk. A lens or review rule for 'identity anchors must be finding-unique' would also cover it.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4069@9fedd31f56d73ca2008b627c6b946aa86c84a76e

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
