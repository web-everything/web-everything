---
kind: task
status: open
parent: "6272"
scope: ["we:backlog/6272-require-named-observable-tests-for-backlog-risk-constraints.md"]
dateOpened: "2026-10-18"
tags: []
---

# Name rollout and diagnostic tests in risk validation plan

PR 5520's later advisory suggestions found that card 6272 promises legacy rollout and diagnostic attribution without exact planned test names. Amend that follow-up's plan before implementation so each acceptance guarantee names a case and an observable result. This card records both suggestions; it does not implement the lint rule.

## Design

Map every acceptance guarantee in [#6272](/backlog/6272-require-named-observable-tests-for-backlog-risk-constraints/) to exact planned cases in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`.

## MVP

Add the missing names and assertions to the existing follow-up, preserving its declared scope and non-goals.

## Done when

- [A1] Card 6272 names `legacy cards without risk mappings remain nonblocking until rollout is enabled`, asserting the chosen legacy policy, and `risk mapping diagnostics identify only the card containing the risk`, asserting the offending card path with a valid neighboring card present.
- [A2] Its missing-file, missing-case, missing-assertion, and complete-mapping guarantees each name an exact planned test and expected diagnostic or acceptance result.

## Edge cases

Keep rollout separate from diagnostic attribution. A test file reference alone cannot substitute for an exact case name and assertion. Authoring the plan does not claim those tests already exist.

## Test plan

Review each acceptance bullet against its named case and assertion, then run the scoped card standards gate. The future rule implementation runs the named content-lint cases through the unit-test gate.

## Proof plan

Show the final acceptance-to-case mapping for every guarantee in card 6272, including legacy rollout and attribution, without changing runtime validation in this planning task.
