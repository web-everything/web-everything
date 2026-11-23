---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-heal-loop.mjs", "we:scripts/conveyor/soak/breaks/rebuild-reader-never-yields.soak.test.mjs", "we:scripts/conveyor/soak/breaks/rebuild-reader-never-yields.mjs", "we:scripts/conveyor/__tests__/ci-heal-loop.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/rebuild-reader-never-yields.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a test or soak probe that runs the loop as a child process twice against a standing claim and… (from web-everything/web-everything#7391 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-heal-loop.mjs:28` — Add a test or soak probe that runs the loop as a child process twice against a standing claim and asserts the second child's behaviour. If a bound is wanted, persist the counter in the claim or lock dir. Otherwise delete the knob and document the TTL as the only bound. I did not run a mutation, since I worked from the diff text and read-only greps of main. A named test that would catch this is a two-process variant of 'bounds consecutive yields'.
2. `we:scripts/conveyor/ci-heal-loop.mjs:151` — Add a lint or check:standards rule that each pre-mortem or Risks bullet in a card names a test file and case. Add a supervisor-level test that restarts the child against a standing claim and asserts a bounded number of restarts until the TTL expires. File this as a backlog card (the PR description mentions a reinforce-later card).
3. `we:scripts/conveyor/soak/breaks/rebuild-reader-never-yields.soak.test.mjs:24` — Add the named integration test to we:scripts/conveyor/soak/breaks/rebuild-reader-never-yields.soak.test.mjs and run it in CI, asserting completed rebuild, adopted overlay, and a restarted reader using the new clone.
4. `we:scripts/conveyor/soak/breaks/rebuild-reader-never-yields.mjs:34` — Add a deterministic integration test to CI that establishes a blocked writer, observes reader yielding, then asserts rebuild completion, adoption=true, and supervisor restart against the adopted clone.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7391@b230660f9f2e2f2f5df9bcc9fe3b8f8aeb9bd926

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
