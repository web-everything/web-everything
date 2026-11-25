---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add cases where a SCRIPT_FAILURE_LINE-shaped tail contains a secret word, and an env secret value… (from web-everything/web-everything#7506 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:476` — Add cases where a SCRIPT_FAILURE_LINE-shaped tail contains a secret word, and an env secret value, and assert '[redacted]'. As a class guard, require a mutation check that every new early-selection path in a redactor has its own redaction case.
2. `we:scripts/lib/enqueue-on-event.mjs:765` — Add one negative case per constraint, each differing from a valid line in only that respect: another prefix with `Error: fast-drain:`, a disallowed character such as `=`, and an over-length reason. Each should assert the unclassified marker.
3. `we:scripts/lib/enqueue-on-event.mjs:765` — Add a table-driven test that feeds the real thrown reasons from we:fast-drain-context.mjs through `firstStderrErrorLine` and asserts each is named, then widen the pattern deliberately where redaction allows.
4. `we:scripts/lib/enqueue-on-event.mjs:814` — Add negative cases on the failure path: a matching line containing 'token', and one containing an env value under DATABASE_URL, both expecting '[redacted]'. As a class guard, require each new publish branch of a redacting function to have a redaction case.
5. `we:scripts/lib/enqueue-on-event.mjs:765` — Add one rejecting case per regex constraint (a disallowed character such as '=' or '.', a 161-character tail, a non-fast-drain Error line, a mid-line match), each expecting the unclassified marker. A mutation check on publish-allowlist regexes would catch the class.
6. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:476` — Track the owed after-proof as a filed item, and once real stderr is captured, add it as a fixture in this test file.
7. `we:scripts/lib/enqueue-on-event.mjs:809` — Narrow the comment to 'only when the first non-warning line has a known error shape', or scan all lines before the failure line for known shapes and test an error behind preamble. A review lens: each 'never' in a comment needs a test of its non-trivial case.
8. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:476` — Add a table-driven redaction regression test for the new accepted shape to the automated test suite.
9. `we:scripts/lib/enqueue-on-event.mjs:811` — Add a deterministic regression test asserting that a genuine error between policy output and the matching tail retains precedence.
10. `we:scripts/lib/__tests__/enqueue-on-event.test.mjs:476` — Add a deterministic regression test for secret-marker and sensitive-environment-value redaction after tail selection.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7506@434fa6c2b8584015abb2b45d1e80df3e1e1e62cc

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
