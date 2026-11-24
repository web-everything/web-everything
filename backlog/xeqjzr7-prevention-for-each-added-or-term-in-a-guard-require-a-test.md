---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/rebuild-job.mjs", "we:scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — For each added OR-term in a guard, require a test where only that term is true. A mutation-testin… (from web-everything/web-everything#7445 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/rebuild-job.mjs:326` — For each added OR-term in a guard, require a test where only that term is true. A mutation-testing pass over changed conditions in CI would catch this class.
2. `we:scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs:966` — Add a PREP lint that maps each Acceptance clause to a named test and fails when a clause has no entry. Short of that, add a review-lens checklist item: every "no bypass during X" needs one test per X.
3. `we:scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs:909` — Add the quarantine-state regression test to the required test suite, asserting that urgent admission leaves the job count unchanged.
4. `we:scripts/lib/daemon-rebuild/rebuild-job.mjs:325` — Add a deterministic sequence test covering urgent completion, interval expiry, ordinary retry completion, and another urgent request for the unchanged target.
5. `we:scripts/lib/__tests__/daemon-self-sync.test.mjs:1518` — Add a deterministic integration test using withSelfSync and production rebuild forwarding, asserting a new queued job exists before tickOnce resolves.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7445@4986b05f917a324f49fd08392dd60af2d7b0d704

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
