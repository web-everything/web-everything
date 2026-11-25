---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/capacity-leaf.mjs", "we:scripts/lib/__tests__/gh-throttle.budget-min.test.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs", "we:scripts/lib/__tests__/capacity-leaf.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a test that pre-acquires the gh-secondary-hits lock, drives a secondary response, and asserts… (from web-everything/web-everything#7476 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:814` — Add a test that pre-acquires the gh-secondary-hits lock, drives a secondary response, and asserts an unchanged call result and no recorded hit. More generally, require a test for each fail-open branch.
2. `we:scripts/lib/gh-throttle.mjs:785` — Have the reader return an unknown or unreadable status distinct from zero, with a test. Until then the Live step should also check calls.jsonl or the rate_limited metric. File under GH-BUDGET-HARDEN.
3. `we:scripts/lib/gh-throttle.mjs:2243` — Skip recording in the outer layer when shimRouted is true, and add a nested-call test asserting one hit per GitHub response.
4. `we:scripts/lib/gh-throttle.mjs:2243` — Classify on stderr only for both main's retry decision and the counter, with a test that puts the phrase in argv alone.
5. `we:scripts/lib/capacity-leaf.mjs:24` — Before setting a newly added leaf, verify that all host readers include it, or have the strict reader ignore unknown keys per policy. File as a card.
6. `we:scripts/lib/gh-throttle.mjs:810` — Under GH-BUDGET-HARDEN, make the reader return an explicit unavailable state and record dropped hits, with a named test for each. Meanwhile, cross-check the zero against `retry` and `retry_exhausted` lines in calls.jsonl during the live step.
7. `we:scripts/lib/__tests__/gh-throttle.budget-min.test.mjs:145` — Add an 'abuse detection' message to the `counts secondary` it.each table; a review lens requiring one case per classifier alternative covers the class.
8. `we:scripts/lib/gh-throttle.mjs:814` — Add a test that pre-reserves the `gh-secondary-hits` lock, then asserts the call result is unchanged, the counter file is untouched and the lock is still held.
9. `we:scripts/lib/__tests__/gh-throttle.budget-min.test.mjs` — File a small readout command that prints the hits and the effective budget with its source, with a test, or record the live evidence on the card before closing it.
10. `we:scripts/lib/capacity-leaf.mjs:24` — File a card so the strict reader tolerates well-formed unknown keys, or have the override setter warn until all consumers have loaded the new leaf. For this rollout, confirm every daemon has reloaded before setting the key.
11. `we:scripts/lib/gh-throttle.mjs:815` — Add a deterministic contention test that exercises failed lock acquisition and asserts unchanged execution and retry timing.
12. `(no file cited)` — Add an acceptance gate requiring each criterion to reference a named automated test or operational check with explicit assertions and recorded results.
13. `(cited file withheld: not a plain path)` — Add a deterministic acceptance-mapping gate requiring every Acceptance item to reference a named automated test or concrete planned operational check with observable assertions.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7476@836ae47a18b5f8b583d59b943dc3e74bda299d3b

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
