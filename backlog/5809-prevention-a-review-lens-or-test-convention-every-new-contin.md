---
bornAs: x8cn472
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/gh-throttle.mjs", "we:scripts/lib/__tests__/gh-throttle.json-retry.test.mjs", "we:scripts/lib/__tests__/gh-throttle.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — A review lens or test convention: every new continue path in the gh-throttle retry loop needs a t… (from web-everything/web-everything#4851 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/gh-throttle.mjs:1752` — A review lens or test convention: every new `continue` path in the gh-throttle retry loop needs a test combining it with the rate-limit ladder. A deterministic gate is not practical.
2. `we:scripts/lib/gh-throttle.mjs:1752` — Classify on `failure.stderr` only, and add a test for an unpiped-stderr caller and for an args-echo false positive. Failing that, a review lens on 'text built from error.message'.
3. `we:scripts/lib/__tests__/gh-throttle.json-retry.test.mjs:78` — Share the retry decision through one helper used by both paths, or parametrise the test suite over both entry points. Filing this as a backlog item is enough.
4. `we:scripts/lib/__tests__/gh-throttle.json-retry.test.mjs:90` — Add a deterministic repeated-failure test for the passthrough loop, asserting exactly two attempts and preservation of the final failure; run it in the standard test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4851@67f5be2ae90e4842c0fb405070779e8c6fa3ebe3

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
