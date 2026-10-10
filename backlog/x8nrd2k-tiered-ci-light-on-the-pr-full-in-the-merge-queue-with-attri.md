---
kind: epic
parent: "4305"
status: open
dateOpened: "2026-10-10"
tags: []
---

# Tiered CI: light on the PR, full in the merge queue, with attribution, isolation and back-off

Held item 198 (session 2026-10-10; held until the GitHub merge queue is live; operator idea). PR push runs only affected tests (since-last-green / related-test selection, #4732) + lint + merge-gate; the merge_group run is the FULL suite. On a red group: attribute (which PR's delta touches the failing test's import/fs graph; flaky check via isolated retry), isolate (bisect the group; GitHub merge queue re-forms groups, or our own split), back off (eject the culprit to review:changes with the failing test as the finding; others re-queue; repeated flake -> quarantine path). Policy settings via the cascade: ci.prTier (light|full), ci.queueTier (full), ci.groupFailure (bisect|eject-suspect), ci.flakeRetry. Depends on PR #4708 (merge-gate as a required check), PR #4717 (enqueue) and the ruleset flip. Parent: delivery strategies. Size 8, so filed as an epic: attribution, bisection, back-off, CI split.

## Acceptance

- [A1] **Executable** — sliced into attribution, bisection, back-off and CI-split stories once the GitHub merge queue is live (PR #4708, PR #4717, ruleset flip).
- [A2] **Live** — a red merge group ejects only the culprit PR, and the others land on re-queue.

## Non-goals

- [N1] Turning on the GitHub merge queue itself (PR #4708 / #4717).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a at epic level: each slice card states its own handling.
2. **Truncated reads** — n/a at epic level: each slice card states its own handling.
3. **Shared state files** — n/a at epic level: each slice card states its own handling.
4. **Fail closed** — n/a at epic level: each slice card states its own handling.
5. **Identity scoping** — n/a at epic level: each slice card states its own handling.
6. **State over time** — n/a at epic level: each slice card states its own handling.
7. **Who wrote it** — n/a at epic level: each slice card states its own handling.
