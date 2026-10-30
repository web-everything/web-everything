---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs", "we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention: require named refusal cases for recovery evidence guards

Review of PR #5612 requested a convention that every invalid-evidence rejection in the card-batch recovery path maps to a named table-driven refusal case. The repair adds the concrete cases; a deterministic convention check should prevent later guards from shipping without their refusal fixtures.

## Acceptance

- [A1] **Executable** — Add planned cases `recovery evidence guards require named refusal coverage` and `complete recovery refusal mapping passes` in `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`. From the WE checkout, run `npm run test:unit -- <test-file>` with that test file. A fixture adding an unmapped invalid-evidence rejection to `respoolClosed` must report a standards error; the same fixture with a named refusal case must pass.
- [A2] Map each current invalid member identity, marker/evidence, change, mode, and encoding rejection in `we:scripts/operations/card-batch-io.mjs` to a named table-driven case in `we:scripts/operations/__tests__/card-batch-io.test.mjs`. Planned case `recovery refusal mapping is complete` must reject both a missing guard mapping and a mapping naming a nonexistent case.

## Non-goals

- [N1] Do not loosen recovery eligibility or change batch lifecycle behavior. This card adds the convention check; PR #5612 supplies the concrete regression cases and subprocess/logging mutation probes.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — A1 fixtures distinguish real guards from matching text inside comments or strings; no source text is executed by the lint.
2. **Truncated reads** — A1 includes an unreadable source/test fixture and requires an explicit error rather than treating it as complete coverage.
3. **Shared state files** — n/a: the convention reads source and tests without writing coordinator state.
4. **Fail closed** — A1 and A2 reject missing mappings, missing named cases, and unreadable evidence.
5. **Identity scoping** — A2 maps guards by recovery function and rejection identity, so an unrelated admission case cannot satisfy the mapping.
6. **State over time** — A1 adds a new guard to a previously complete fixture and requires the check to become red.
7. **Who wrote it** — n/a: source/test mapping establishes coverage, not author authority.
