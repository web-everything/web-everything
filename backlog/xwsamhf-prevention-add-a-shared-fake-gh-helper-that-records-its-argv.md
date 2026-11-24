---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/ci/__tests__/check-timings-bot-only.test.mjs", "we:scripts/ci/check-timings-bot-only.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a shared fake-gh helper that records its argv and lets tests assert the exact endpoint and re… (from web-everything/web-everything#7414 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/ci/__tests__/check-timings-bot-only.test.mjs:57` — Add a shared fake-`gh` helper that records its argv and lets tests assert the exact endpoint and revision range. Add a test that the guard refuses a base ref outside the allowed character set. Filing this as a backlog card is the cheapest option; no deterministic gate exists for it today.
2. `we:scripts/ci/__tests__/check-timings-bot-only.test.mjs:70` — Add a helper for these CLI tests that records the gh argv and asserts the exact compare path and base ref. Back it with a lint rule that rejects fake-gh branches the code under test never calls.
3. `we:scripts/ci/__tests__/check-timings-bot-only.test.mjs:65` — Make the fake gh reject unexpected arguments and add a named test asserting the exact compare endpoint with a non-main base and explicit head SHA; run it in the existing test gate.
4. `we:scripts/ci/check-timings-bot-only.mjs:59` — Add a deterministic CLI regression test accepting 150 rename entries while retaining the existing 300-file rejection test, and count API file entries separately.
5. `we:scripts/ci/__tests__/check-timings-bot-only.test.mjs:65` — Make the fake CLI reject unexpected compare endpoints and add a named test using a non-main base ref and an explicit head SHA.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7414@429eaabaac665a262a770899ed04faf4578b88f1

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
