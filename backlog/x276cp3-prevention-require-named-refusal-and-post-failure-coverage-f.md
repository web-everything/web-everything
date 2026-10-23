---
kind: task
status: open
scope: ["we:scripts/lib/operation-io-fidelity.mjs", "we:scripts/lib/__tests__/operation-io-fidelity.test.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-22"
tags: []
---

# Prevention: require named refusal and post-failure coverage for operation sinks

PR #5829 review identified unprotected coverage promises in operation IO sinks. Add a deterministic ratchet that reports unsafe-reference throw guards without named sibling negative tests and multi-post effects without fault injection for each post. Require zero writes for unsafe references and a recoverable held state when a release post fails. Add fixtures proving a missing negative test and a missing post-failure test are detected, while covered sinks pass. Extend the verified-scope call-site work already tracked by #6842 to include rulableBreaks in operation IO modules. The immediate record-red-team-ruling tests cover the reported sink; this task tracks the repository-wide prevention rule. This is local source/test tooling and needs no network, rate limit, CSRF control, or state-reset endpoint.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- scripts/lib/__tests__/operation-io-fidelity.test.mjs` detects an uncovered unsafe-reference refusal in a sink fixture and accepts a fixture with a named negative test asserting zero writes.
- [A2] **Executable** — The same suite detects a multi-post effect missing fault injection at one post, and accepts coverage of every post with a recoverable end state.
- [A3] **Executable** — The same suite distinguishes omitted standing-ruling scope in operation gate calls from explicitly supplied verified scope; coordinate the broader call-site rule with #6842.

## Non-goals

- [N1] Changing operation authorization, card-reference syntax, or GitHub posting behavior.

## Edge cases this change must handle

1. **Untrusted text** — Inspect source as syntax, never execute fixture text; include newline, backtick and traversal input cases.
2. **Truncated reads** — Report unreadable or unsupported source as incomplete coverage rather than silently passing it.
3. **Shared state files** — n/a: checks read local source and tests, without persistent shared state.
4. **Fail closed** — Missing refusal or recovery coverage must be reported; a test title alone does not establish behavioral coverage.
5. **Identity scoping** — Bound checks to sibling operation tests; do not credit unrelated test names.
6. **State over time** — Fault injection must exercise each post boundary and retry, including the final release post.
7. **Who wrote it** — Fixtures are repository-owned source; no model or comment body may declare its own coverage sufficient.
