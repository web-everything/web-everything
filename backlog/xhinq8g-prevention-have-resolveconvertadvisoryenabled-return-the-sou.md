---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Prevention — Have resolveConvertAdvisoryEnabled return the source of its decision, or phrase the log neutrally… (from web-everything/web-everything#5059 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:skills-src/conveyor/review-daemon.mjs:1022` — Have resolveConvertAdvisoryEnabled return the source of its decision, or phrase the log neutrally ('stage disabled via setting or env'). This is a wording fix and needs no gate.
2. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs` — Add a deterministic test using the resolver's default path with a mocked file read returning enabled:false, assert the repository-qualified path read, and require the resolver to return false.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5059@3d7c6a3b87524a0208fb76e121a9ca806244b641

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
