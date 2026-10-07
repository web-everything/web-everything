---
bornAs: xwycrhp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/verify-base-rerun.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/__tests__/verify-base-rerun.test.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/lib/__tests__/lane-verify.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Give the pre-existing verdict its own distinct status, or add a test that runs every verifyGateDe… (from web-everything/web-everything#4212 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/await-verify-pass.mjs:88` — Give the pre-existing verdict its own distinct status, or add a test that runs every `verifyGateDecision` consumer (await-verify-pass, wait-for-settle, pr-land) against a pre-existing-red record.
2. `we:scripts/verify-lane.mjs:673` — Add an integration test that runs verify-lane against a fixture lane with a failing out-of-diff test, and unit tests for `probeLaneVerifyMarkers` red-marker output and the `fixer-verify-never-settles` status skip. Longer term, extract the wiring into a pure `classifyRunRedCause` function so the standard test gate covers it.
3. `we:scripts/lib/verify-base-rerun.mjs:33` — A check:standards lint that flags tmpdir()-rooted caches read back in gate or verify decision code unless the dir is created with mode 0700 and validated. Alternatively, a review-lens checklist item: 'does a cache feed a pass/fail gate?'
4. `we:scripts/conveyor/health-watch.mjs:513` — A shared helper for probes that read lane markers, which validates sha shape and caps string length and array size. Back it with a lint or test asserting probes never forward raw marker sub-objects.
5. `we:scripts/lib/lane-verify.mjs:584` — Review-lens rule: every 'X only' or 'never' comment in a gate decision needs a named negative test. A deterministic version is a lane-verify test table that enumerates each guard condition of verifyGateDecision and asserts a failing variant for each.
6. `we:scripts/lib/verify-base-rerun.mjs:81` — Add a deterministic integration test containing both a matching assertion failure and an unhandled runner error; require ok:false and retention of the blocking red verdict.
7. `we:scripts/lib/verify-base-rerun.mjs:75` — Add a deterministic subprocess integration test with a hanging descendant that holds stdout open; require bounded completion and descendant cleanup, backed by process-tree termination with escalation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4212@be14272cb0231b3a7ec2cd13659cf2233c5cee73

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
