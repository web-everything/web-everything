---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-loop-cli.mjs", "we:scripts/operations/__tests__/review-loop-cli.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a lens or check that every flag in a security-relevant open() has a test asserting its presen… (from web-everything/web-everything#7562 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-loop-cli.mjs:604` — Add a lens or check that every flag in a security-relevant open() has a test asserting its presence or its observable effect, for example a real FIFO fixture.
2. `we:scripts/operations/review-loop-cli.mjs:667` — Make the error-stop payload a redacted outcomePayload plus the diagnostic fields, and add a contract test that review-job's parser still extracts verdict and loop from an effect-halted payload.
3. `we:scripts/operations/review-loop-cli.mjs:613` — Add a real-FIFO case to the debug-log tests. As a deterministic gate, require every security-relevant open flag named in a comment to appear in an `openSync` flag assertion.
4. `we:scripts/operations/review-loop-cli.mjs:606` — Extend the descriptor test to assert O_NONBLOCK and add a timeout-bounded subprocess test opening a real FIFO without a reader.
5. `we:scripts/operations/review-loop-cli.mjs:608` — Add a deterministic O_NONBLOCK assertion to the descriptor test and a named, timeout-bounded subprocess test that attempts logging to a FIFO without a reader.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7562@b6964d93ed85614f489a21cbec603e319884f101

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
