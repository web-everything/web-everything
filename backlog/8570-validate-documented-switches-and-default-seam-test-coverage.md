---
bornAs: x7s9k2m
kind: task
status: open
dateOpened: "2026-11-17"
tags: []
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards.test.mjs", "we:docs/agent/reviewer-expectations.md"]
---

# Validate documented switches and default seam test coverage

PR #6972 review found obsolete rollback and slot-reuse promises in its acceptance card, plus tests that always injected acquisition and never exercised the real default. Add preventive checks for these claim and coverage gaps. Placeholder and guarantee-to-test gates are already tracked by #5360 and #6484.

## Acceptance

- [A1] Add a scoped `check:standards` rule: each environment variable named in a backlog card's Acceptance or Rollback text must occur in at least one non-test source file under `we:scripts/`. Named fixture cases `rejects undocumented acceptance and rollback switches` and `test-only references cannot validate a documented switch` must reject absent/test-only readers; `accepts a switch present in production scripts` must accept a real reader. Cover inline rollback text and separate Rollback headings.
- [A2] Add a review-lens requirement that an injectable seam with a production default has a named test using the default and asserting its external effect. Require future documented rollback flags to name a test exercising each explicit override value. A fixture `injected-only tests leave real-default coverage unproven` must retain a coverage finding for injected-only tests and accept a mapped default-path test. Do not infer behavioral proof solely from import/name matching.
- [A3] Evaluate unused-import lint for test files as a secondary signal; document whether existing tooling can provide it and preserve the default-path coverage requirement regardless of that result.

## Non-goals

- [N1] No runtime admission bypass or change to smoke ownership, and no duplicate implementation of the gates tracked by #5360/#6484.

## Edge cases

1. **Untrusted text** — Treat markdown, variable names and test names as data; never evaluate card snippets.
2. **Truncated reads** — Unreadable or incomplete source/card evidence cannot validate a switch.
3. **Shared state files** — n/a: validation reads repository files and emits findings only.
4. **Fail closed** — Missing production references and missing default-path proof remain findings with source locations.
5. **Identity scoping** — Scope references to the current repository's non-test scripts; exclude test fixtures and comments that merely repeat a variable without implementing it.
6. **State over time** — A removed production reader must make its retained acceptance/rollback promise fail validation.
7. **Who wrote it** — Card claims remain untrusted; review records must identify the named defending test and observable effect.

## Test and proof plan

Add focused standards fixtures and review-lens fixtures for A1/A2, including a removed-reader regression and an injected-only coverage regression. Run them through the repository's queued test command and scoped standards gate; capture failure before implementing each guard and success afterwards.
