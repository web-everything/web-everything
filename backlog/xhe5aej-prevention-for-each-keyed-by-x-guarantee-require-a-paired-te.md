---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/merge-queue.replay.test.mjs", "we:scripts/lib/merge-queue.mjs", "we:scripts/lib/merge-freshness.mjs", "we:backlog/xs1hdl7-drain-fresh-main.md", "we:scripts/lib/__tests__/merge-queue.test.mjs", "we:scripts/lib/__tests__/merge-freshness.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — For each 'keyed by X' guarantee, require a paired test where X differs (a new head against an old… (from web-everything/web-everything#4538 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/merge-queue.replay.test.mjs:148` — For each 'keyed by X' guarantee, require a paired test where X differs (a new head against an old record). Capture it as a review-lens checklist item, or as a mutation-testing gate on the pure-rule libraries.
2. `we:scripts/lib/merge-queue.mjs:99` — Add a replay case in which the head is `refuse`, and define in the protocol card whether the next entry may be promoted. File it as a follow-up before the drain hook lands.
3. `we:scripts/lib/merge-freshness.mjs:53` — Add `validateFreshnessSettings` (finite positive `maxAgeMinutes`, boolean flags), call it from `assessMergeFreshness` and `planQueue`, and add a table test of bad values. A lint or standards rule against `x > NaN`-prone threshold math on config values would be broader.
4. `we:scripts/lib/merge-queue.mjs:99` — Add a ruled policy for a blocked head (a max wait, then demote the head or skip it) and a replay test with a refused or pending head ahead of a fresh PR. Do this before the drain hook is enabled.
5. `we:backlog/xs1hdl7-drain-fresh-main.md:79` — Add a line to the drain-hook acceptance saying the class must come from a trusted source (an allowlisted actor or label-applier), plus a hook test that an unauthorised marker leaves the class `normal`.
6. `we:scripts/lib/merge-freshness.mjs:53` — Add a CI-enforced parameterized test covering incomplete file facts with allowDisjointMainMoves both false and true, asserting facts-incomplete from assessMergeFreshness and refuse from planQueue.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4538@83bb2b829bade24cebe07ce2c3007b025fe25ea6

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
