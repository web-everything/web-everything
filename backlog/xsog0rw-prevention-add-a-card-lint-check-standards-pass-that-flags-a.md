---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/xdzzp2l-plateau-shell-plan-step-dz-shell-five-task-based-sections-ro.md", "we:backlog/x9sujbc-first-external-access-beta-release-gate.md", "we:backlog/x23lblp-scan-test-continue-and-handoff-commands-carry-no-hard-coded.md", "we:backlog/x7ihyw5-red-team-honesty-lens-checklist-in-redteamprompt-with-regres.md", "we:backlog/xt9bmkj-check-branding-validator-icon-cleanup-and-gradient-hue-span.md"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a card-lint (check:standards) pass that flags acceptance lines in one card that mention the s… (from web-everything/web-everything#7375 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/xdzzp2l-plateau-shell-plan-step-dz-shell-five-task-based-sections-ro.md` — Add a card-lint (check:standards) pass that flags acceptance lines in one card that mention the same symbol with opposing requirements, or require a reviewer lens on carried acceptance. Cheapest practical guard is a doc note on carry-forward, because the contradiction is not script-decidable.
2. `we:backlog/x9sujbc-first-external-access-beta-release-gate.md` — Add a check:standards rule that a card with no `blockedBy` and an Executable acceptance line must name a test file path. Alternatively, add a prepare-step lens for 'buildable-now cards need a named test'.
3. `we:backlog/xdzzp2l-plateau-shell-plan-step-dz-shell-five-task-based-sections-ro.md:24` — A review lens or checklist item: when a card carries acceptance from several source cards, require a one-line reconciliation of overlapping or contradictory clauses. This is not script-decidable.
4. `we:backlog/x9sujbc-first-external-access-beta-release-gate.md:16` — A check:standards rule for cards tagged release-gate or security: acceptance items must reference a repo-qualified test path, and the Fail closed edge-case line must not be n/a.
5. `we:backlog/xdzzp2l-plateau-shell-plan-step-dz-shell-five-task-based-sections-ro.md:17` — Require acceptance-to-test references at preparation, including separate assertion mappings for route membership, redirect classes and internal-link migration.
6. `we:backlog/x23lblp-scan-test-continue-and-handoff-commands-carry-no-hard-coded.md:16` — Require validator cards to map each rejected input class and target file to a named planned fixture case, with an explicit recorded check for human decisions.
7. `we:backlog/xt9bmkj-check-branding-validator-icon-cleanup-and-gradient-hue-span.md:17` — Require validator acceptance criteria to name negative fixtures for each enforced rule and explicit named manual checks for visual assertions.
8. `we:backlog/x9sujbc-first-external-access-beta-release-gate.md:16` — Require each gate guarantee to map to a named planned test and assertion matrix covering statuses, identity states and request paths.
9. `we:backlog/x7ihyw5-red-team-honesty-lens-checklist-in-redteamprompt-with-regres.md:16` — Require carry-forward cards to map every source acceptance ID to a destination acceptance ID and a named planned test or explicitly identified manual verification case.
10. `(no file cited)` — Add a deterministic ruling-manifest check comparing expected card IDs, final statuses, metadata and required annotations against the edited cards.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 5 → #5668, finding 8 → #5473, finding 11 → #5473, finding 13 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7375@1e849b0ede76496cabf04c8dc1f7fe48deb4c1e0

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
