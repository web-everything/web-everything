---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lane-drain.mjs", "we:scripts/__tests__/lane-drain.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a PR-description lint that fails when the diff adds a new process.env.WE_* knob or changes a… (from web-everything/web-everything#3923 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lane-drain.mjs:830` — Add a PR-description lint that fails when the diff adds a new process.env.WE_* knob or changes a default that is not named in the description. Otherwise split behavior-policy changes into their own PR.
2. `we:scripts/lane-drain.mjs:850` — Review lens: when a diff deletes a comment that states a fail-closed rationale, require the PR body to name the policy change. A check:standards rule could also flag removals of 'fail closed' comment blocks without a matching description mention.
3. `we:scripts/lane-drain.mjs:870` — Use a separate effective-ledger copy for read-time exclusion. Add a test that pre-seeds the ledger for a held hash and asserts the persisted file is unchanged.
4. `we:scripts/lane-drain.mjs:961` — Add a deterministic regression test that warms the cache, introduces a hash filename using an already-reachable blob, and requires the cached classification to match the full walk.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3923@32b331a82bc2e1b9cc88137f60632c0f669cf765

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
