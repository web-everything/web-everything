---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/red-team-label-settle.test.mjs", "we:scripts/lib/red-team-status-labels.mjs", "we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/__tests__/red-team-status-labels.test.mjs", "we:scripts/lib/__tests__/drain-red-team-evidence.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Make the gh mocks match exact endpoint paths, and add a test helper that fails if a registered mo… (from web-everything/web-everything#7236 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/red-team-label-settle.test.mjs:65` — Make the gh mocks match exact endpoint paths, and add a test helper that fails if a registered mock branch is never hit. Better still, add a mutation check that removes `strictSummary` and expects a named test to fail.
2. `we:scripts/lib/red-team-status-labels.mjs:43` — Add a test that exercises each production call shape of the settle (gate-apply with no evidence, review-job with evidence). Better, make the settle require `typeof evidence.ok === 'boolean'` before it can clear, so a missing value is unknown. Either would be a deterministic gate.
3. `we:scripts/lib/__tests__/red-team-label-settle.test.mjs` — Make this named test a deterministic regression gate: set the process-only marker directory, create the marker, pass a partial env, and assert that settling is refused.
4. `we:scripts/lib/drain-red-team-evidence.mjs:117` — Add a deterministic test gate that injects a non-ENOENT read failure for each local marker type and asserts settlement is refused.
5. `we:scripts/lib/red-team-status-labels.mjs` — Add a deterministic regression test that changes the head during the final check read and requires setLabels not to run; place the head verification after that read.
6. `we:scripts/lib/__tests__/red-team-label-settle.test.mjs` — Make this named test create a carried-check marker beneath a process-environment directory, omit that directory from the explicit environment, and assert false; require it in the test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7236@6a28dc635352f022f9be6e6686d35074599cad8d

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
