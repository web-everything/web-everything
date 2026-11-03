---
bornAs: x49q3hf
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:wip-relay.js", "we:./__tests__/wip-relay.test.mjs"]
dateOpened: "2026-10-01"
tags: []
---

# Prevention — Add a contract test that builds a worst-case daemons panel at the validator's maximum array sizes and asser… (from chalbert/plateau-app#190 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:wip-relay.js:253` — Add a contract test that builds a worst-case daemons panel at the validator's maximum array sizes and asserts the serialized snapshot stays under MAX_BODY_BYTES. Alternatively, cap the hold/dispatched lists in readDispatchLog and show an 'N more' line in the view.
2. `we:wip-relay.js:238` — Add a relay-contract case, `(p) => { p.launchd[0].label = 'org.other'; }`. More generally, each validator branch that calls `fail` should have a matching reject case, which a coverage-threshold gate on `we:wip-relay.js` branches would enforce.

Idempotency key (do not edit): approval-prevention-key:chalbert/plateau-app#190@a116fbd291823098342d890d02bbcc711a2d035f

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
