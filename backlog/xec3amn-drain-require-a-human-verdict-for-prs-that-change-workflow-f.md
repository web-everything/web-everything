---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/drain-workflow-edit-hold.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# drain: require a human verdict for PRs that change workflow files, matching the merge-gate

The drain merged #4816 (it changed the CI workflow) and #4876 (it changed the merge-gate workflow) on an AI review alone, while the merge-gate holds any PR touching a workflow file until a clear-human ceremony at the exact head (workflowEditFact / workflowEditHold). Make the drain apply the same rule, reusing workflowEditHold from we:scripts/lib/merge-queue-enqueue.mjs, behind a cascade setting (default ON).

## Acceptance

- [A1] **Must** refuse workflow edits without a trusted clear-human ceremony at the exact head; replay #4816 and #4876 through the drain's real review decision. Setting `off` restores the prior decision, while exact-head clearance permits the existing gates to decide.
- [A2] **Must** recover unknown, capped or head-mismatched local change lists with the merge-gate’s full pinned change-list reader at the acceptance head against the default branch. A successful read decides normally: workflow files park human-only; non-workflow files pass. Read errors defer this pass without a label write and name the error; incomplete non-local or malformed evidence also defers. Clearance cannot waive unreadable file evidence. Non-workflow docs, config, data and code still pass this additional check; workflow YAML and renamed-from workflow paths remain human-only.
- [A5] **Must** avoid any extra acceptance or git read in the bare/waived sweep for a complete non-workflow listing; prove zero calls with a counting exec. Replay #4816 with more than 100 entries including its three workflow files, a capped non-workflow list, and a full-list read failure.
- [A3] **Executable** — decision, cascade and incident replay:

```bash
npm run test:unit -- scripts/lib/__tests__/drain-workflow-edit-hold.test.mjs scripts/__tests__/drain-workflow-edit-replay.test.mjs --reporter=verbose
```

- [A4] **Executable** — existing review-gate regressions (at most two files per invocation):

```bash
npm run test:unit -- scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs scripts/__tests__/merge-ai-prs-review-escalation-and-rollup-dedup.test.mjs
npm run test:unit -- scripts/__tests__/merge-ai-prs-ai-detection-and-drain-ordering.test.mjs scripts/__tests__/merge-ai-prs-drain-verdict-ledger.test.mjs
npm run test:unit -- scripts/__tests__/merge-ai-prs-revalidation-unknown-mergeability.test.mjs scripts/lib/__tests__/human-clearance-carry.test.mjs
npm run check:standards
```

## Non-goals

- [N1] Change the shared workflow path rule, the GitHub merge-queue enqueue refusal, or any existing merge prerequisite.
- [N2] Add another clearance parser, migrate settings, or edit the CodeQL settings reader. The new reader owns only `drainWorkflowEditHuman` in the existing tool settings file.
- [N3] Add a receive/write endpoint: body-size caps, rate limits, CSRF/origin checks and reset-trigger protections are n/a for this local decision and read-only settings resolver.

## Edge cases this change must handle

1. **Untrusted text** — Reuse the shared trusted-author clearance parser; a forged comment does not clear the hold. Paths are inspected by the shared workflow predicate, never executed.
2. **Truncated reads** — A local listing at its cap or for another head triggers a full pinned git read at the acceptance head (listing head when no acceptance exists), against the default branch. No local checkout means defer; a read error means defer with its error and no label, even with human clearance. Never park merely because the list is incomplete.
3. **Shared state files** — Read settings only; missing/malformed tool JSON means that layer is unset. Resolve built-in → platform → tool → env and log the winner once per pass.
4. **Fail closed** — Default on; unreadable change lists and acceptance read errors defer without label writes, never merge or park human-only. Only explicit setting `off` disables this additional gate.
5. **Identity scoping** — Read comments and select listed files for the same repository and PR; clearance must match that PR's current head case-insensitively.
6. **State over time** — A clearance at an older head does not authorize a workflow edit at the new head, including identical-diff carry-forward; each pass re-evaluates evidence.
7. **Who wrote it** — AI `review:accepted` alone cannot clear workflow edits. The existing acceptance reader owns ceremony trust; reuse it without creating a second author policy.
