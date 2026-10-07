---
bornAs: xm83ahf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/held-cards-check.mjs", "we:scripts/held-cards-io.mjs", "we:scripts/__tests__/held-cards-check.test.mjs", "we:scripts/__tests__/held-cards-io.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Expand Sa..Sb ranges inside extractRefs and add a unit case for a partly merged range. A review l… (from web-everything/web-everything#4236 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/held-cards-check.mjs:43` — Expand `Sa..Sb` ranges inside extractRefs and add a unit case for a partly merged range. A review lens on parsers that read range syntax would also catch this.
2. `we:scripts/held-cards-io.mjs:193` — Add fixture tests drawn from real held-list items that cite an origin PR, run through the io path, and make the dependency regex stricter or opt-in. Run the live check against a real list and review each likely-done by hand before merge.
3. `we:scripts/__tests__/held-cards-check.test.mjs:65` — A test checklist item: every documented flag in the we:SKILL.md usage line has at least one test. Add a default-fetch case to the check test.
4. `we:scripts/held-cards-check.mjs:48` — Add a deterministic extraction-and-assessment regression test requiring intermediate slices in an explicit range to be accounted for before returning likely-done.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4236@0d1276a3167d569e6afbbaeed93dba53145902b7

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
