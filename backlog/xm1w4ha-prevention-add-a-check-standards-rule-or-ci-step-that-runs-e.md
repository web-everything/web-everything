---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/soak/breaks/same-head-hold-clean-head-never-resolves.mjs", "we:scripts/conveyor/soak/breaks/review-human-escalated-head-no-advisory.mjs", "we:scripts/conveyor/soak/breaks/__tests__/same-head-hold-clean-head-never-resolves.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/review-human-escalated-head-no-advisory.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Prevention — Add a check:standards rule or CI step that runs every soak break whose fixedBy.paths or marker st… (from web-everything/web-everything#7564 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/soak/breaks/same-head-hold-clean-head-never-resolves.mjs:87` — Add a `check:standards` rule or CI step that runs every soak break whose `fixedBy.paths` or marker strings reference a file the PR touches. Alternatively, put the soak breaks in the default include so a changed contract reddens in the normal run.
2. `we:scripts/conveyor/soak/breaks/review-human-escalated-head-no-advisory.mjs:151` — A standards check that rejects `fixedBy.sha: 'pending'` on a break whose paths are already present at merge time.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7564@351147fda7d45fde98e920a9a27731db5c3d62c1

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
