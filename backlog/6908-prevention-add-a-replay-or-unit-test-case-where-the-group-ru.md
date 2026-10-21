---
bornAs: xmeiz7b
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/main-ci-red-io.mjs", "we:scripts/conveyor/health-smells/main-ci-red.mjs", "we:scripts/conveyor/__tests__/main-ci-red-group-evidence.test.mjs", "we:scripts/conveyor/__tests__/main-ci-red-io.test.mjs", "we:scripts/conveyor/health-smells/__tests__/main-ci-red.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add a replay or unit test case where the group run's PR carries a fix for the failing job. Then e… (from web-everything/web-everything#5278 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/main-ci-red-io.mjs:205` — Add a replay or unit test case where the group run's PR carries a fix for the failing job. Then either require the group PR's changed files to be unrelated or non-code, or accept that the re-run is only a cheap probe and say so.
2. `we:scripts/conveyor/health-smells/main-ci-red.mjs:93` — Gate the clause on `failing.flake?.eligible && failing.flake.reason === 'merge-group-green-on-tip'`. Skip the group read when `failingRun.attempt > 1`. Add the already-rerun case to the smell test.
3. `we:scripts/conveyor/__tests__/main-ci-red-group-evidence.test.mjs:67` — Add a deterministic regression case with two non-summary failed jobs and assert null evidence when only one passed, then positive evidence when both passed.
4. `we:scripts/conveyor/__tests__/main-ci-red-group-evidence.test.mjs:105` — Add a deterministic zero-limit test asserting no merge-group list or job reads while the evidence setting remains enabled.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5278@d52ac57aea753a4f24a649b464b6675679bd743a

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
