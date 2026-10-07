---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/worker-brief.mjs", "we:scripts/__tests__/held-cards-io.test.mjs", "we:scripts/__tests__/worker-brief.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Validate with the same predicate the consumer uses (if (edgeClone) { ...SAFE check }), and add a… (from web-everything/web-everything#4215 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/worker-brief.mjs:50` — Validate with the same predicate the consumer uses (`if (edgeClone) { ...SAFE check }`), and add a boundary test for ''.
2. `we:scripts/__tests__/held-cards-io.test.mjs:288` — Inject a counting touch via the withPathLock path, or drive a `file` run with a fake exec and assert the beat count. For the writer rule, use a lint rule instead of a regex scan.
3. `we:scripts/__tests__/held-cards-io.test.mjs:260` — Add a deterministic test observing the destination before rename and injecting a rename failure; assert the old destination remains intact and the temporary file is cleaned up.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4215@cc85b5343579ca9ead4c895ecc54de6100ebbc72

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
