---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/__tests__/ci-heal-admission.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add deterministic assertions for logging at both admission sites and an acceptance gate requiring… (from web-everything/web-everything#7531 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/reconcile-core.mjs:3680` — Add deterministic assertions for logging at both admission sites and an acceptance gate requiring each promise to reference a named test or executable operational check with its result.
2. `we:scripts/conveyor/__tests__/ci-heal-admission.test.mjs:59` — Add a planner-level test in we:reconcile-core-ci-heal-admission.test.mjs for a main-fix-priority PR with a main-only hold and open red window, asserting refusal 'main-red'. Longer term, a lint rule that every `kind: 'ci-heal'` push in we:scripts/conveyor/reconcile-core.mjs is preceded by `admitCiHeal`.
3. `we:scripts/conveyor/reconcile-core.mjs:3675` — Add `expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'x-merge-gate-unreadable', prNumber }))` to the unreadable-verdict tests in we:merge-gate-hold-class.test.mjs and we:reconcile-core.test.mjs. Also confirm the kind is allowed by any note-kind validation.
4. `(no file cited)` — Add an acceptance-validation gate requiring each verification requirement to reference a named check and its retained evidence.
5. `we:scripts/conveyor/reconcile-core.mjs:3680` — Gate the planner tests on log assertions for both admission bases and push sites, and require the Acceptance checklist to link the named oracle's retained output.
6. `(no file cited)` — Add a deterministic acceptance-evidence gate requiring each operational criterion to reference a named check and its result artifact, including assertions for admission class and basis.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7531@5dc85b3ddbd5659be3fa2a40ee5bd46fc9a2c7fe

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
