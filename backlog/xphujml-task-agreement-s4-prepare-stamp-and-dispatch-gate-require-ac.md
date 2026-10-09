---
kind: story
size: 5
parent: "5399"
status: open
blockedBy: ["xdeqs8k", "x251p1l"]
scope: ["we:scripts/conveyor/prepare-result.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/backlog.mjs", "we:skills-src/conveyor/prepare-item-agent-brief.md", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs", "we:scripts/conveyor/__tests__/prepare-result.test.mjs", "we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs"]
scopeRationale: "we:scripts/lib/task-agreement-policy.json is named in [A5] only as the committed policy file the real loader READS; this slice never writes it (the test points the loader at a fixture policy file, and flipping the setting is a separate change per [N1]), so it is deliberately not in scope."
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S4: prepare stamp and dispatch gate require Acceptance and Non-goals (needs-task-agreement hold)

Slice S4 of #5399 (ruled 2026-10-08, Forks 1 and 2): prepareCardStatus requires both sections under enforce, and dispatchPlan holds a stamped story that lacks them, or has a draft section, with a new needs-task-agreement reason routed to the prepare agent. Under advise the checks only log. The prepare brief writes both sections and moves the MVP out-of-scope line to Non-goals. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a `dispatch-plan` test holds a stamped story with no `## Non-goals`, or with a draft-marked section, as `needs-task-agreement` under `enforce`, and dispatches it under `advise`. The draft-marked case feeds a FULL card (frontmatter and HTML comments included, marker written exactly as S2 writes it) through the real `prepareCardStatus` and dispatch path, so the test fails if the marker does not survive comment stripping.
- [A2] **Executable** — a `prepare-result` test shows `prepareCardStatus` refuses a stamp without both sections under `enforce` and only reports it under `advise`.
- [A3] **Observable** — the new hold reason appears in the dispatch-eligibility output and routes the card to the prepare agent; the prepare brief writes both sections and moves its out-of-scope sentence to `## Non-goals`.
- [A4] **Executable** — a `dispatch-plan` test shows that under `enforce` a story whose section cannot be parsed is held as `needs-task-agreement`, and that a story stamped before the flip with no `## Non-goals` is held at dispatch even though its stamp is still current.
- [A5] **Executable** — an integration test goes through the real `we:scripts/backlog.mjs` IO-shell path, not an injected policy: with the real loader pointed at a fixture policy file set to `enforce` (the committed `we:scripts/lib/task-agreement-policy.json` is never rewritten by the test), a stamped story without `## Non-goals` is held as `needs-task-agreement`; with it set to `advise`, the same story dispatches. A missing, unreadable or invalid policy file is never read as `advise`: it is read as `enforce` and the reason is reported in the dispatch output.
- [A6] **Executable** — a `prepare-result` test passes the section text the prepare brief writes (`## Acceptance` and `## Non-goals`) through the Must-cite, TODO-placeholder and provenance-escape readers and shows they see the sections, so no prepared card loses a check. This slice waits for S7, which moves those readers to the shared reader.

## Non-goals

- [N1] Flipping the setting to `enforce` (a separate one-line change on the trigger in #5399).
- [N2] Checking fix, ci-heal, prepare-item, epic, feature, decision or investigation cards.
- [N3] Changing the `## MVP` Musts cut beyond moving the out-of-scope list.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
4. **Fail closed** — under `enforce`, an unparseable or draft section reads as not agreed (hold), never as agreed. A missing or invalid policy file reads as `enforce` with the reason reported, never as a silent `advise` (tested by [A5]).
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — a card stamped before the rule is re-checked at dispatch, so the flip applies to old stamps too.
7. **Who wrote it** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
