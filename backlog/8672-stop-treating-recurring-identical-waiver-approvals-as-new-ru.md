---
bornAs: xpswxqf
kind: task
status: open
scope: ["we:scripts/operations/open-pr.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Stop treating recurring identical waiver approvals as new rulings

39 PRs on 2026-11-20 needed the same waiver approved again. No fix exists. Add a fix slice so a repeat of an already-approved identical waiver is applied by the system, not re-asked. Source: lessons-report LESSON-CARD recurring-waiver-approval (8:38 PM ET).

## Acceptance

- [A1] **Executable** — Planned `reuses approved identical waiver without another question` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Replay the same waiver after approval; assert it is applied with zero new approval requests.
- [A2] **Executable** — Planned `requires approval for changed or unapproved waiver` in `we:scripts/operations/__tests__/open-pr.test.mjs`: Parameterize a changed waiver and a waiver without prior approval; assert neither is applied before approval.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No broader waiver authority.

## Edge cases this change must handle

1. **Untrusted text** — Waiver prose cannot self-approve.
2. **Truncated reads** — Incomplete approval evidence requires a fresh decision.
3. **Shared state files** — Read stored approvals without mutating their provenance.
4. **Fail closed** — An uncertain identity match retains the approval requirement.
5. **Identity scoping** — Match the exact waiver and its applicable scope.
6. **State over time** — Cover repeated identical requests and changed approvals.
7. **Who wrote it** — Only recorded valid approval permits reuse.

## Duplicate admission

new card from 2026-11-20 build-queue CARD line
