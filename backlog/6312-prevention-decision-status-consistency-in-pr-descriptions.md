---
bornAs: x8z4n6v
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/decision-pr-status.mjs", "we:scripts/lib/__tests__/decision-pr-status.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-10-18"
tags: [prevention, decisions, review]
---

# Prevention: compare decision status in PR descriptions with card frontmatter

PR #5549's 2026-10-18 advisory found that its description still called decision 6268 open for ratification while the card and codified ruling were resolved. Add a pure PR-description check and document its use before hand-back, so reviewers see the current decision state.

Accept the final description and changed decision cards as explicit inputs. Report a contradiction when a description says a referenced resolved decision is still open or awaiting ratification, or claims ratification for an open card. Return the exact card id and contradictory statement. Keep historical quotations separate from the description's current-state assertion. Require a manual status check when a description has no explicit assertion; do not invent operator approval or rewrite a ruling to match stale prose.

## Acceptance

- [A1] **Executable** — `npm run test:unit --` on we:scripts/lib/__tests__/decision-pr-status.test.mjs (new). Named tests:
  - `a resolved decision described as still open or awaiting ratification reports a contradiction`
  - `an open decision described as ratified reports a contradiction`
  - `consistent current status passes and a quoted historical status does not override it`
  - `multiple decision cards are compared by exact id without borrowing another cards status`
  - `missing or unreadable card status requires an explicit manual check instead of claiming consistency`
  - `hostile description text is treated as data and never executed`
- [A2] The workflow documents the check at final PR-description review and requires a current status statement when the automatic check cannot decide. Replay the supplied #5549 description and resolved card as a mismatch fixture.

## Non-goals

- [N1] Does not establish whether an operator ruling was authorized, change review labels, or mutate a PR or decision card.

## Edge cases this change must handle

1. **Untrusted text** — descriptions and quoted statements are data (A1 hostile-text test).
2. **Truncated reads** — missing card input requires manual review (A1 unreadable-status test).
3. **Shared state files** — n/a: pure comparison over supplied inputs.
4. **Fail closed** — ambiguous status is not reported as verified (A1 missing-status test).
5. **Identity scoping** — exact decision id, independently for each card (A1 multiple-card test).
6. **State over time** — compare the final description and current card state, preserving historical quotes as history (A1 historical-status test).
7. **Who wrote it** — prevention owed by the PR #5549 advisory; the operator remains the authority for ratification.
