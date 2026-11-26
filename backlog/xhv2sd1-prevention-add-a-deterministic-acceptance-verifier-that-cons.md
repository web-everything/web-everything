---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xmq7453-check-first-live-main-reuse.md", "we:scripts/ci/__tests__/mq-result-reuse.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic acceptance verifier that consumes the recorded run IDs and asserts SHA equali… (from web-everything/web-everything#7453 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/xmq7453-check-first-live-main-reuse.md:12` — Add a deterministic acceptance verifier that consumes the recorded run IDs and asserts SHA equality, summaries, job outcomes, timing selection, and receipt completeness.
2. `we:scripts/ci/__tests__/mq-result-reuse.test.mjs:420` — Add a contract test that creates an active quarantine entry, runs the real `we:quarantine-skip.mjs` for each job variant, and asserts the output matches the receipt step's exclusion pattern. Better, have we:quarantine-skip.mjs export the flag prefixes and have both sides consume them.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7453@72dfca1a1b4ef7793de119821f0bef6261b1bd8d

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
