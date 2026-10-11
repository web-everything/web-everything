---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/lib/judge-spawn.mjs", "we:scripts/operations/run-record.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/lib/__tests__/judge-spawn.test.mjs", "we:scripts/operations/__tests__/run-record.test.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Store a hash of the request and compare hashes. Alternatively, add a test asserting the record si… (from web-everything/web-everything#4865 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/cli-adapter.mjs:1050` — Store a hash of the request and compare hashes. Alternatively, add a test asserting the record size stays under the health probe's per-file cap.
2. `we:scripts/lib/judge-spawn.mjs:720` — Only accept the fallback line if its shape matches a full result (`session_id` present and either `structured_output` or `result`). Add a test with a forged trailing verdict line. A review lens or lint rule, 'parsers of subprocess output must not widen what a verdict accepts', would cover this class.
3. `we:scripts/operations/run-record.mjs:123` — Run a shared secret and control-character redaction helper over stderr before it is stored or put in an error message. Add a check:standards rule that any code persisting subprocess stderr must go through the helper.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4865@f6d2033ddc3ce6e788277998028ffb441223f204

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
