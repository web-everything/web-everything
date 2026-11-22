---
kind: story
size: 1
status: open
scope: ["we:scripts/operations/__tests__/run.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Test every declared CLI operation builds a CLI spec (no control-flag input collisions)

PR #7322's resolve-generated op declared an input named cwd, which collides with a reserved control flag in we:scripts/operations/cli-adapter.mjs (CONTROL_FLAGS), so the op could not run at all, not even --help. Only a per-op test caught it after red team. Add one test that loops over every declaration in OPERATIONS and CLI_ONLY_OPERATIONS (we:scripts/operations/run.mjs) and asserts buildCliSpec does not throw, so the next op cannot ship with a colliding input name (help, json, resume, answer, run-id, cwd).

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/run.test.mjs`: a new case builds the CLI spec for every declaration in OPERATIONS and CLI_ONLY_OPERATIONS. It fails when any declaration names a control-flag input (proved by a fixture declaration with input `cwd`), and passes on current main.

## Non-goals

- [N1] Does not rename any existing input or change CONTROL_FLAGS; it only adds the guard test.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads only in-repo declarations.
2. **Truncated reads** — n/a: no external reads.
3. **Shared state files** — n/a: building a declaration must not touch run stores; the test builds declarations only, never runs them.
4. **Fail closed** — a factory that throws while building its declaration fails the test, naming the operation.
5. **Identity scoping** — n/a: no identities involved.
6. **State over time** — new operations are covered automatically, because the test enumerates the registries rather than a fixed list.
7. **Who wrote it** — n/a: no markers or authored content.
