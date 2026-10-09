---
kind: story
size: 3
parent: "5467"
status: open
scope: ["we:skills-src/conveyor/fix-agent-brief.md", "we:skills-src/conveyor/fix-agent-ci-brief.md", "we:scripts/lib/class-sweep-rule.mjs", "we:scripts/conveyor/class-sweep-check.mjs", "we:scripts/lib/review-fix-policy-settings.json"]
dateOpened: "2026-10-08"
tags: []
---

# Fixer class sweep: name each finding's defect class and check its sibling paths

Operator 2026-10-08 (fix quality first). The fix and ci-heal briefs require, per finding, the defect CLASS and a check of its sibling paths (same function family, callers, parallel branches, the fix's own new recovery/error paths): each sibling fixed or listed checked / n/a, in a structured class-sweep block in the evidence comment and the recorded sweep. A cheap deterministic check reports a missing or incomplete sweep; mode is a setting (off today, warn first). Evidence: fixer audit 2026-10-08 — 7 findings caused by fixes (uncovered sibling paths #4481, holes in the fix's own recovery code #4433).

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
