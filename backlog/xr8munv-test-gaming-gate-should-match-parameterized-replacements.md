---
kind: task
status: open
scope: ["we:designs/pr7196-test-removal-ruling-2026-11-21.md", "we:scripts/__tests__/test-gaming-parameterized.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Test-gaming gate should match parameterized replacements

The test-gaming gate flagged #7196 though both removed tests became it.each rows in the same files. The gate should recognise parameterized replacements. See we:designs/pr7196-test-removal-ruling-2026-11-21.md. Source: build-queue 00:33 ET 2026-11-21.

## Acceptance

- [A1] **Executable** — Planned `accepts equivalent parameterized replacement in the same file` in `we:scripts/__tests__/test-gaming-parameterized.test.mjs`: Replace removed individual tests with equivalent it.each rows in a real diff fixture; assert no lost-assertion finding.
- [A2] **Executable** — Planned `flags actual assertion loss despite parameterization` in `we:scripts/__tests__/test-gaming-parameterized.test.mjs`: Remove an assertion while adding it.each rows; assert the gate still reports the lost guarantee.

Run `npm run test:unit -- <test-files>` through the host heavy-run queue using the repository-relative paths after the `we:` prefixes above. These cases are planned; this card does not claim they already pass.

## Non-goals

- [N1] No exemption for every parameterized rewrite.

## Edge cases this change must handle

1. **Untrusted text** — Test names and source text remain data.
2. **Truncated reads** — Incomplete diffs cannot prove replacement coverage.
3. **Shared state files** — n/a: comparison fixtures need no shared-state writes.
4. **Fail closed** — Unmatched or unparseable replacements retain the finding.
5. **Identity scoping** — Match replacements within the relevant file and test.
6. **State over time** — Cover the before/after transformation explicitly.
7. **Who wrote it** — Require source assertions, not a claimed replacement.

## Duplicate admission

nd
