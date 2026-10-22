---
bornAs: xql6q2b
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/", "we:scripts/lib/__tests__/", "we:scripts/check-standards-rules.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: map overlay audit guards to named regression tests

PR #5809 review found guard guarantees without named tests. Add a scoped check that maps each audit-fix guard to a named behavioral test and reports missing references for new fails-closed or never claims. Enumerate fallback-* alert kinds in we:scripts/lib/daemon-rebuild/smoke.mjs and require a failing-smoke test for each fallback branch, including planA2 and planB. Cover we:scripts/lib/daemon-rebuild/plan.mjs, we:scripts/lib/daemon-rebuild/smoke.mjs and we:scripts/lib/daemon-rebuild/adopt.mjs. The repair adds the immediate content-free-pin, lost-overlay fallback, force-pushed-ready and instruction-length tests; the automated coverage check remains owed.

## Acceptance

- [A1] **Executable** — Add a fixture-based standards check: a new audit guard or fails-closed/never claim with no named test reference must fail; the same fixture with a valid behavioral-test reference must pass. Run it in the normal diff-selected verify gate.
- [A2] Enumerate smoke fallback alert kinds and require named failing-smoke cases for planA2 and planB, including loss of a carried overlay. Reject missing or stale test names.
- [A3] Document which references are behavioral regression pins and which have verified revert-red evidence. Existing guards must not be weakened to obtain proof.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No change to overlay planning, credential authorization, or branch-coverage thresholds across unrelated tooling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Parse file paths and test names as data; never execute reference text or shell fragments.
2. **Truncated reads** — Report unreadable or incomplete diff/test data rather than certifying coverage.
3. **Shared state files** — n/a: the check reads the checkout and writes no shared state.
4. **Fail closed** — Missing, renamed or unresolvable test references fail the scoped guard check.
5. **Identity scoping** — Restrict references to the repository and changed guard family under review.
6. **State over time** — A renamed/deleted test must invalidate its guard reference on the next gate run.
7. **Who wrote it** — A textual claim alone is not evidence; resolve the named test and retain the trusted gate's result.
