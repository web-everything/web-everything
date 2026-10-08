---
bornAs: x6wv20q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prevention — Wrap everything after the reservation in one try/finally-style release-on-failure. Add a test whe… (from web-everything/web-everything#4398 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/dispatch-lane-io.mjs:1532` — Wrap everything after the reservation in one try/finally-style release-on-failure. Add a test where `ensureSessionCwd` throws and assert `releaseLane` was called. No lint gate fits; this is a review-lens item for acquire-then-act sequences.
2. `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs:165` — Review lens: for every prose guarantee of the form 'X is kept/never done on path Y', require a named negative test.
3. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:609` — Add a unit test for each real release helper with a stub exec that asserts the exact argv and rejects `--force`/`--release-reserved`. For the class, add a standards check that any code shelling out to `we:lane-pool.mjs release` has a test asserting no `--force`.
4. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:608` — Add a deterministic ownership-transition regression test covering the real release adapter and lane ownership enforcement.
5. `we:scripts/operations/__tests__/dispatch-lane-io.test.mjs:144` — Add a deterministic environment-value matrix test invoking reserveBuildLane without the enabled override.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4398@e6b79a4ceac3b65c91bc00060af189ccaa55b5ca

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
