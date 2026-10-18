---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/fix-run.mjs", "we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# we: Trim the Codex fixer brief and sandbox

Why: in the Codex fixer sessions (273 in the window), 26% (72 sessions, about 85 min a day) ran check:standards themselves, though the launcher runs scoped standards and verify after the pass. 35% of file reads (1,412 of 4,026) re-read a file the session had already read. Denied commands: ps in 30 sessions and kill in 7, each costing a wasted turn. The heavy-admission lock rename hit EPERM in 5 sessions (12 times). Change: tell the Codex fixer not to run check:standards or the full unit suite beyond its red-proof file, add a file digest to the brief so repeat reads are not needed, state that ps and kill are denied, and add the admission lock directory to the writable roots. Scope: we:scripts/operations/fix-run.mjs and we:scripts/codex-direct-task.mjs. Edge cases to handle: a digest that goes stale after an edit must be refreshed; sandbox widening stays limited to the admission lock directory.

[A1] Executable: npx vitest run we:scripts/operations/__tests__/fix-run.test.mjs

## Acceptance

- [A1] **Executable** — a new test in we:scripts/operations/__tests__/fix-run.test.mjs asserts the Codex brief carries the file digest, says ps and kill are denied, and bars check:standards beyond the red-proof file. It fails before this lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the red-proof test the fixer must run, the launcher's own verify, or the sandbox mode. Does not widen writes beyond the admission lock directory.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the digest is built from the repo's own files. PR text stays out of it.
2. **Truncated reads** — the digest records each file's length and hash, so a truncated file shows up as a mismatch and is read again.
3. **Shared state files** — the digest is written per session, never to a shared file.
4. **Fail closed** — if the digest cannot be built, the brief omits it and the fixer reads files as it does today.
5. **Identity scoping** — n/a: the brief belongs to one fixer session.
6. **State over time** — the digest is rebuilt at each launch, so an edited file is never served stale.
7. **Who wrote it** — n/a: the launcher writes the brief and the digest, and the brief names it as the source.
