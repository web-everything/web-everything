---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/red-main-quarantine-62da75ed3.test.mjs", "we:scripts/lib/red-main-quarantine.mjs", "we:scripts/lib/__tests__/red-main-quarantine.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Have the PR description's replay claims quote the test case name and its outcome, and review it a… (from web-everything/web-everything#5283 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/red-main-quarantine-62da75ed3.test.mjs:78` — Have the PR description's replay claims quote the test case name and its outcome, and review it against the test titles. A review lens is enough; a deterministic gate is not practical for prose.
2. `we:scripts/lib/red-main-quarantine.mjs:170` — Add a check:standards rule or test that every job matching unitJobPattern has a we:ci.yml step invoking quarantine-skip with a matching --job. Alternatively, gate the widened pattern on the wiring being present.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5283@6d2cea2de9f1a03b197c8d94f29211164e7299a2

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
