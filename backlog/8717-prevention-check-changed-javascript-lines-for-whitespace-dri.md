---
bornAs: xxvig7z
kind: task
status: open
dateOpened: "2026-11-25"
tags: []
---

# Prevention: check changed JavaScript lines for whitespace drift

Prevention owed by PR #7491's correctness/style finding. An unrelated edit changed `const escapeXml = value` to `const escapeXml =value`; the repair restores the spacing. Add a formatter or whitespace lint to the scoped standards gate that can identify this kind of changed-line drift without reformatting unrelated files.

## Acceptance

- [A1] **Executable** — A named standards-check fixture rejects the changed JavaScript declaration `const escapeXml =value => value;` and accepts `const escapeXml = value => value;`.
- [A2] **Executable** — The scoped check examines the supplied changed files or lines, reports the relative path and location, and leaves all bytes unchanged. Pin that read-only behavior in its test.
- [A3] **Executable** — Existing unrelated formatting does not force a whole-repository rewrite; invalid or unreadable changed-file evidence produces a nonzero diagnostic instead of a clean result.

## Non-goals

- [N1] Automatic source rewriting, a repository-wide formatting migration, or changes to XML escaping behavior.

## Edge cases this change must handle

1. **Untrusted text** — Pass filenames through argv or filesystem APIs; never evaluate source or interpolate it into shell text.
2. **Truncated reads** — Bound fixture/source reads and report incomplete input as a failure.
3. **Shared state files** — The check must not write source files or shared formatter state.
4. **Fail closed** — Missing checker dependencies and unreadable selected files fail visibly.
5. **Identity scoping** — Limit selection to repository-relative changed JavaScript files.
6. **State over time** — Repeated checks produce the same diagnostics and leave source unchanged.
7. **Who wrote it** — n/a: formatting diagnostics grant no authority to perform effects.
