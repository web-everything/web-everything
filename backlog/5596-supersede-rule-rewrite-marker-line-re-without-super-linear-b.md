---
bornAs: xo882jb
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/supersede-rule.mjs", "we:scripts/conveyor/__tests__/supersede-rule.test.mjs", "we:scripts/conveyor/ci-heal-verdict-recheck.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Supersede rule: rewrite MARKER_LINE_RE without super-linear backtracking; caps hold after a ci-heal verdict void

Follow-up from #4560 review (operator approved with follow-up 2026-10-09; fix soon). MARKER_LINE_RE in we:scripts/conveyor/supersede-rule.mjs backtracks super-linearly on crafted comment text, which the daemon reads from PR comments. Rewrite it as a single linear pattern or a plain string parse and add an adversarial timing test. Also add a test that the fix/ci-heal attempt caps still apply after a ci-heal not-a-ci-break verdict is voided.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/supersede-rule.test.mjs` adds an adversarial timing case (a long crafted line that is slow with the current MARKER_LINE_RE) that fails on main and passes after, under a fixed time budget.
- [A2] MARKER_LINE_RE is replaced by a single linear pattern or a plain string parse; every existing marker test still passes unchanged.
- [A3] A test shows the fix and ci-heal attempt caps still apply after a ci-heal not-a-ci-break verdict is voided.

## Non-goals

- [N1] Changing the supersede hold policy itself (#5586).
- [N2] Changing when a ci-heal verdict is voided (#5585).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR comment text is untrusted; the parser must run in linear time on any input.
2. **Truncated reads** — n/a: this follow-up opens no new case of this class.
3. **Shared state files** — n/a: this follow-up opens no new case of this class.
4. **Fail closed** — an unparseable marker line is treated as no marker.
5. **Identity scoping** — n/a: this follow-up opens no new case of this class.
6. **State over time** — n/a: this follow-up opens no new case of this class.
7. **Who wrote it** — n/a: this follow-up opens no new case of this class.
