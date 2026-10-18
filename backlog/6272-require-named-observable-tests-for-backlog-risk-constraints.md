---
bornAs: xrc0nrr
kind: task
status: open
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
scopeRationale: "Extend the existing test-plan content-lint cases; the rules module has split test files rather than a single sibling test."
dateOpened: "2026-10-17"
tags: []
---

# Require named observable tests for backlog risk constraints

PR 5520 repeated a coverage gap because a promised fallback guard constraint had no named regression. Add deterministic card validation requiring each Risks constraint to name a repository-qualified test file, exact case name, and observable assertion. Typed refusal codes and the missing regressions ship in the originating repair; this task covers the broader validation rule.

## Acceptance

- [A1] **Executable** — Add cases to `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` for missing test-file references, missing exact case names, missing observable assertions, and a complete valid risk mapping. Run that file through the unit-test heavy queue.
- [A2] Existing cards need an explicit rollout policy before a new rule blocks the full corpus. Keep diagnostic attribution on the card containing the risk.

## Non-goals

- [N1] Infer whether a named test actually proves its assertion, execute arbitrary commands from cards, or change referral and acceptance behavior.

## Edge cases this change must handle

1. **Untrusted text** — Parse Markdown as data; never execute test names or commands.
2. **Truncated reads** — Follow the existing card reader's limits and report unreadable input.
3. **Shared state files** — n/a: validation creates no shared state.
4. **Fail closed** — Report each missing component; a generic file-only test-plan bullet cannot satisfy a risk.
5. **Identity scoping** — Require repository-qualified test paths and bind each mapping to its own risk.
6. **State over time** — Define the legacy-card rollout before enabling blocking enforcement.
7. **Who wrote it** — n/a: validation neither trusts prose as authority nor writes review verdicts.
