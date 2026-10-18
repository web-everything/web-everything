---
bornAs: xekdulp
kind: story
size: 2
status: active
scaffoldedBy: "fix-5551"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/conveyor/pr-status-label.mjs", "we:scripts/lib/red-team-status-labels.mjs", "we:scripts/lib/__tests__/red-team-gate.test.mjs", "we:scripts/operations/__tests__/operator-queue.test.mjs", "we:scripts/operations/__tests__/operator-queue-red-team.test.mjs", "we:scripts/operations/__tests__/operator-queue-entry.test.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs", "we:scripts/lib/__tests__/red-team-status-labels.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team display readers ignore saved-evidence gate decisions (NOT READY reason, status labels)

PR #5551 made RULING NEEDED, operator-why and the clear-human ruling read the gate's saved red-team result (savedRedTeamFallback) when the thread has no posted result. Two display-only readers of the same disposition still read the thread alone: redTeamQueueReason (operator-queue evaluatePr / evaluateCeremonyOwed NOT READY reason and pr-status-label's sent-back-red-team status) and planRedTeamStatusLabels (red-team:blocked vs pending). After a saved send-back they omit the red-team reason and show red-team:pending instead of red-team:blocked. Admission is unaffected (the drain hold reads saved evidence). Thread the same lazy readSaved option through these readers; evaluatePr has no repo today, so the caller must supply it.

## Acceptance

- [A1] **Executable, planned** — `we:scripts/operations/__tests__/operator-queue-red-team.test.mjs`, case **saved send-back supplies the NOT READY reason**: with no posted result, `redTeamQueueReason` returns the saved send-back reason for the live repository, PR and head. Case **queue evaluations pass repository identity to saved evidence** in `we:scripts/operations/__tests__/operator-queue-entry.test.mjs` asserts that both evaluatePr and evaluateCeremonyOwed expose that reason.
- [A2] **Executable, planned** — `we:scripts/lib/__tests__/red-team-status-labels.test.mjs`, case **saved send-back labels the live head blocked**: `planRedTeamStatusLabels` adds `red-team:blocked` and removes `red-team:pending`. Case **saved send-back supplies the sent-back status** in `we:scripts/conveyor/__tests__/pr-status-label.test.mjs` asserts `sent-back-red-team`.
- [A3] **Executable, planned** — In the A1 and A2 test files, parameterize **saved display evidence is identity scoped and refreshed** over wrong repo, PR, head and a later head change; assert that an old saved break never supplies the live reason or blocked label. **posted display evidence wins over saved evidence** asserts no saved read with a usable posted result. **unreadable saved display evidence remains pending** asserts an explicit unavailable/pending state, never a clean result.
- [A4] **Executable, planned** — In the A1 and A2 test files, **operator clearance releases saved display holds** uses an authorized result-bound clearance and asserts removal of the saved hold; stale or untrusted clearance leaves it blocked. Parameterize source, docs, config and data paths: identical evidence yields identical display decisions.

## Non-goals

- [N1] Do not change drain admission, gate routing, result storage or publication. Reuse `savedRedTeamFallback` and `readRedTeamDisposition`; do not add a second policy.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Return policy reasons, never raw saved finding text; A1's planned NOT READY case asserts the reason excludes a sentinel finding summary.
2. **Truncated reads** — A3's unavailable-evidence case covers malformed and incomplete saved reads without claiming a clean result.
3. **Shared state files** — Readers only; reuse the existing store reader. A3's refresh case replaces the saved row between evaluations and asserts the second evaluation reads it anew.
4. **Fail closed** — A3 preserves pending/unavailable for unreadable evidence; A4 keeps breaks blocked without authorized clearance.
5. **Identity scoping** — A3 tests repo, PR and exact head; repository identity must reach both queue entry points.
6. **State over time** — A3 tests posted precedence and a changed head; A4 tests result-bound clearance.
7. **Who wrote it** — A4 tests that untrusted authors cannot clear a saved hold; reuse shared marker authorship checks.

## Risks

The queue entry points currently lack consistent repository context. An implicit local-repo default could leak another repository's display evidence; A1 wiring and A3 identity cases must cover explicit and local repo callers. Do not let an IO failure appear as a clean result.

## Test plan

All cases above are planned, not implemented by PR #5551. Run `npm run test:unit --` with the four test files named in A1 and A2 (strip the `we:` locus prefix for CLI arguments). Add the named cases first and show the saved send-back reason and blocked-label assertions red before implementing the reader wiring. Include the existing shared gate and queue suites in the affected-test gate; their paths are included in scope.
