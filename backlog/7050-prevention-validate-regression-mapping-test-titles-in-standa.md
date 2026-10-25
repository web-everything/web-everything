---
bornAs: xebglin
kind: task
status: open
scope: ["we:scripts/check-standards.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/", "we:docs/agent/testing.md"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention: validate regression mapping test titles in standards checks

PR #5890 review found that the Regression mapping in we:docs/agent/testing.md cited a nonexistent needs-you test while the actual test asserted policy clearance. The immediate repair restores the refusal contract. Add a deterministic check:standards rule resolving every mapped title to an existing test in its cited files, including parameterized titles. Require new settlement clearing paths to name stale and contradictory refusal tests. This is local documentation/source validation with no network endpoint or shared runtime state.

## Acceptance

- [A1] **Executable** — `npm run check:standards`, scoped to we:docs/agent/testing.md, reports a missing mapped test title, an unreadable cited file, or an unsupported mapping; valid mappings pass.
- [A2] **Executable** — Unit fixtures in we:scripts/__tests__/ exercise direct it() and parameterized it.each titles, escaped quotes and literal percent placeholders; a title in a comment, describe(), or an unrelated file does not satisfy a mapping.
- [A3] **Executable** — The real Regression mapping in we:docs/agent/testing.md passes; deleting or renaming its not-owed needs-you test in a fixture fails. Scope the rule so edits to either mapped tests or their documentation trigger validation.
- [A4] **Review** — Each new clearing path in we:scripts/lib/red-team-skip-outcome.mjs must cite tests proving both its allowed case and refusal of stale or contradictory evidence. Retain the accepted-code not-owed contract test in the affected-test gate.

## Non-goals

- [N1] Inferring behavioral correctness from titles, executing cited source, or changing red-team policy.

## Edge cases this change must handle

1. **Untrusted text** — Parse test source as syntax; never evaluate a title, parameter table, or documentation text.
2. **Truncated reads** — Missing, unreadable or unsupported mapped evidence fails with a useful file/title diagnostic.
3. **Shared state files** — n/a: local read-only validation creates no shared state.
4. **Fail closed** — Missing mappings fail; a matching string in a comment cannot satisfy a test claim.
5. **Identity scoping** — Resolve exact titles only within the cited test files, preserving percent placeholders.
6. **State over time** — Renaming or deleting a cited test must fail the next scoped standards check.
7. **Who wrote it** — Repository documentation supplies claims; parsed test declarations supply existence evidence.
