---
bornAs: x8qx9fq
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a parameterised test over the non-tick-in-progress prep failure reasons asserting the count i… (from web-everything/web-everything#3987 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild.mjs:1973` — Add a parameterised test over the non-tick-in-progress prep failure reasons asserting the count is unchanged. A review-lens note on 'a state counter with a reason-filtered increment needs a negative test' would also help.
2. `we:scripts/lib/__tests__/daemon-rebuild.test.mjs:233` — Add a deterministic fake-clock test that keeps the reader active through the default escalated deadline and asserts both tick-in-progress and elapsed time; also exercise an explicit timeout override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3987@8d8bac8e4fd79dff61dc04c23806852a2c2b67ff

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
