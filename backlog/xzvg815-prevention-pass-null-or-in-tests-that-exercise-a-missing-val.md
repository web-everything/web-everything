---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/__tests__/ruling-cli-loud.test.mjs", "we:scripts/operations/record-red-team-ruling.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Pass null or '' in tests that exercise a missing-value branch, never undefined for a defaulted pa… (from web-everything/web-everything#7241 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/__tests__/ruling-cli-loud.test.mjs:34` — Pass `null` or `''` in tests that exercise a missing-value branch, never `undefined` for a defaulted parameter. Capture this as a review-lens note on defaults; there is no cheap deterministic gate for it.
2. `we:scripts/operations/record-red-team-ruling.mjs:339` — Add a test assertion that each refusal's useCmd names a file that exists. For we:run.mjs targets, also assert the op is registered.
3. `we:scripts/operations/__tests__/ruling-cli-loud.test.mjs:33` — Add the named regression test to the automated test gate, explicitly removing process.argv[1] during the assertion and restoring it afterward.
4. `we:scripts/operations/__tests__/ruling-cli-loud.test.mjs:33` — Add a named missing-argv test using a valid module URL and an actually absent process.argv[1], asserting false and no write or exit calls; use it as a deterministic regression gate.
5. `we:scripts/operations/__tests__/ruling-cli-loud.test.mjs:16` — Make the existing parameterized direct-run tests assert each operation's expected refusal text, providing a deterministic gate against missing or swapped operation names.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7241@67589c39e402a47adde1a556f341f6354a3ad080

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
