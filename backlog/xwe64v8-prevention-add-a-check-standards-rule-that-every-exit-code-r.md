---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/operations/pr-sweep-core.mjs", "we:scripts/operations/review-job.mjs", "we:skills-src/conveyor/__tests__/review-daemon.test.mjs", "we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/lib/__tests__/review-red-team-on-skip.test.mjs", "we:scripts/operations/__tests__/pr-sweep-core.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/conveyor/soak/breaks/__tests__/review-dispatch-without-expected-head.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a check:standards rule that every exit-code/refusal branch added in scripts/operations/*.mjs… (from web-everything/web-everything#7430 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/review-dispatch.mjs:756` — Add a check:standards rule that every exit-code/refusal branch added in scripts/operations/*.mjs CLI entry points has a test referencing it (or a CLI-spawn contract test per entry point).
2. `we:skills-src/conveyor/review-daemon.mjs:866` — Review lens: for each 'gets no X' clause in a comment, require a matching negative assertion in the same test.
3. `we:scripts/lib/review-red-team-on-skip.mjs:1200` — Add a test in we:review-red-team-on-skip.test.mjs for a head-less row asserting dispatch is not called with a bogus head and that row.why names the refusal; file as a card.
4. `we:scripts/operations/pr-sweep-core.mjs:213` — Add a we:pr-sweep.test.mjs case asserting nextActions(...).rerunReview.command contains --expected-head=<headRefOid>.
5. `we:scripts/operations/review-job.mjs:1704` — State 'job mode' in the PR/test names, or add a session-mode test that pins current (unguarded) behaviour so later lanes change it deliberately.
6. `we:scripts/operations/review-dispatch.mjs:757` — Add a CLI-level test for review-dispatch (missing head gives exit 75 and no spawn; a head is forwarded). Longer term, a standards rule that every `process.exitCode = N` branch needs a named test.
7. `we:scripts/operations/pr-sweep-core.mjs:213` — Add a `nextActions` test that asserts the rerun command contains a 40-hex `--expected-head` when the PR has a head, and omits the command otherwise.
8. `we:scripts/operations/review-dispatch.mjs:753` — Parametrize the no-head refusal test over both dispatch modes, so the claim is checked wherever it is made. Or have `dispatchReviewByMode` enforce the head check before it routes by mode.
9. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:140` — Add a deterministic multi-PR, multi-tick regression test asserting unchanged lastDispatched, available lane capacity, and redispatch after refusal; this guard needs a backlog filing.
10. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:5` — Capture a named integration check with observable successful dispatch and zero-start head-stripped refusal assertions; require its recorded result for this acceptance item and file the missing guard.
11. `we:skills-src/conveyor/__tests__/review-daemon.test.mjs:140` — Add deterministic multi-candidate, multi-tick regression coverage and a mutation gate that inserts cooldown and occupied-lane updates into the refusal branch.
12. `we:scripts/conveyor/soak/breaks/review-dispatch-without-expected-head.mjs:5` — Require each Acceptance guarantee to reference a named test or planned live scenario, with a deterministic completeness check on that mapping.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7430@a28652e6d091d9202dd2aa8cccaae750f618c721

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
