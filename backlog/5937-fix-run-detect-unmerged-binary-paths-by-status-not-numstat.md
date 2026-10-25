---
bornAs: xz73kbf
kind: story
size: 1
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/operations/__tests__/fix-run.test.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# fix-run: detect unmerged binary paths by status, not numstat

The reported numstat bug is already addressed in this checkout: porcelain status selects unmerged paths, then attributes and index-stage blobs distinguish binary/non-regular conflicts. The launcher aborts unsupported conflicts before starting the agent.

## Acceptance

- [A1] `t=we:scripts/operations/__tests__/fix-run.test.mjs; q=we:scripts/readiness/heavy-admission.mjs; node "${q#we:}" run -- npx vitest run "${t#we:}"` — Existing regression at line 613 creates a real binary UU conflict (whose unmerged numstat is 0/0), asserts merge abort, no agent launch and the recorded binary refusal. Lines 629–649 cover the other stage and merge attributes. This is closure evidence; do not invent a replacement implementation.

## Non-goals

- [N1] No binary conflict resolver and no loosening of text conflict safeguards. This CLI adds no receive endpoint; HTTP body limits, rate limits and CSRF are inapplicable.

## Edge cases this change must handle

1. **Untrusted text** — Use NUL-delimited git status and argv-safe paths, including whitespace or shell metacharacters.
2. **Truncated reads** — A failed status, attribute or blob read must not be treated as an empty successful conflict scan.
3. **Shared state files** — Only the claimed lane index/worktree is affected; abort the merge without touching another lane.
4. **Fail closed** — Binary, non-regular and unsupported conflict codes abort before agent execution; preserve refusal recording for source, documentation, config and data alike.
5. **Identity scoping** — Run every git query and abort against the same claimed lane and PR base.
6. **State over time** — After refusal, MERGE_HEAD must be gone; subsequent attempts must not inherit a half-merged index.
7. **Who wrote it** — The launcher records the refusal; model output is not evidence that a binary conflict was resolved.

## Grounding

- we:scripts/operations/fix-run.mjs:151 parses unmerged status; line 221 classifies binary paths from attributes and stage blobs.
- we:scripts/operations/fix-run.mjs:731 selects conflicts by status and line 739 aborts unsupported conflicts.
- we:scripts/operations/__tests__/fix-run.test.mjs:613 exercises real git binary UU conflicts.

## Open questions

STALE: both the implementation and requested real-git regression are present. Should this card be closed as already shipped?
