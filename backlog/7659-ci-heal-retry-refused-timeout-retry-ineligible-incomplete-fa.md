---
bornAs: x3q893i
kind: story
size: 2
status: open
scope: ["we:forge-exec-run.test.mjs", "we:scripts/lib/repo-scan-tests.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# CI-heal retry refused `timeout-retry-ineligible` (incomplete-failure-inventory / missing-check-origin) on #601

HIGH priority hint. - [HIGH] CI-heal retry refused `timeout-retry-ineligible` (incomplete-failure-inventory / missing-check-origin) on #6017/#6023/#6033/#6044, even though the failures are named test failures. One daemon bug blocks 4 PRs (judge sweep 10-28 19:32 ET). - QUEUED when load allows: #6017 takeover (one line: register we:forge-exec-run.test.mjs in we:scripts/lib/repo-scan-tests.mjs); build idle-claim auto-release (R201).

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
