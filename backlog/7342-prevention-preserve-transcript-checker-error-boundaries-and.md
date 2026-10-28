---
bornAs: xzf0juu
kind: task
status: open
scope: ["we:scripts/codex-direct-task.mjs", "we:scripts/lib/codex-transcript-check.mjs", "we:scripts/lib/codex-transcript-policy.mjs", "we:scripts/__tests__/codex-direct-task.test.mjs", "we:scripts/lib/__tests__/codex-transcript-check.test.mjs"]
dateOpened: "2026-10-28"
tags: []
---

# Prevention: preserve transcript checker error boundaries and shipped defaults

PR #5912 advisory prevention: require named regressions for missing checker imports, shipped warn/3000000 with tool provenance, unreadable settings and platform preferences with fail selection, both foreground output modes, and inert executable-looking custom input with a static dynamic-evaluation guard. The repair adds these guards; retain them when reorganizing the checker. Extend orchestration linting to detect optional post-run imports outside an error boundary.

## Acceptance

- [A1] Add a static orchestration check that rejects an optional post-run import outside an error boundary; cover guarded and unguarded fixtures with named tests.
- [A2] Preserve the named default, import-failure, policy-error and execution-sentinel regressions added by PR #5912 in `we:scripts/__tests__/codex-direct-task.test.mjs` and `we:scripts/lib/__tests__/codex-transcript-check.test.mjs`.
- [A3] Run the affected test gate and demonstrate that an unguarded-import fixture fails the new static check.

## Non-goals

- [N1] Do not change the transcript detection heuristics or the shipped warn default.

## Edge cases this change must handle

1. **Untrusted text** — Treat source text and transcript input as inert; comments and string examples must not impersonate an import site.
2. **Truncated reads** — Refuse incomplete source inspection instead of reporting a clean scan.
3. **Shared state files** — n/a: the proposed static check reads source only.
4. **Fail closed** — Unknown check coverage must be explicit and cannot certify a completed scan.
5. **Identity scoping** — Scope diagnostics to the inspected file and import site.
6. **State over time** — Keep the regression fixtures when the orchestration layout changes.
7. **Who wrote it** — n/a: no actor-authored runtime state is consumed.
