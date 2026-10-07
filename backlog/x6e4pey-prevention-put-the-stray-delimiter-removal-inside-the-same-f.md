---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/held-cards-check.mjs", "we:scripts/__tests__/held-cards-check.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Put the stray-delimiter removal inside the same fixpoint loop, or use while (/&lt;!--|--&gt;/.tes… (from web-everything/web-everything#4242 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/held-cards-check.mjs:38` — Put the stray-delimiter removal inside the same fixpoint loop, or use `while (/&lt;!--|--&gt;/.test(out)) out = out.replace(/&lt;!--|--&gt;/g, '')`. Add a property-style test that fuzzes strings over the alphabet `<`, `!`, `-`, `>` and asserts that neither delimiter appears in the output.
2. `we:scripts/held-cards-check.mjs:38` — Add a property-style test that fuzzes short strings over the alphabet {<,!,-,>} and asserts the output contains neither `&lt;!--` nor `--&gt;`. Also keep CodeQL a required check, as the PR itself suggests.
3. `we:scripts/held-cards-check.mjs:38` — Extend the delimiter-invariant test with malformed opening and closing delimiters, and stabilize the entire cleanup operation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4242@c37efb7ca4309dcaab74b43ebcd685f8ca87661d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
