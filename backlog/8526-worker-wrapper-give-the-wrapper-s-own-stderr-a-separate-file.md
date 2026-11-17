---
bornAs: xuxaht4
kind: story
size: 1
status: active
scaffoldedBy: "fix-5460"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/operations/worker-wrapper.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# worker-wrapper: give the wrapper's own stderr a separate file from the child's captured smoke stderr

Found reviewing PR #5460. launchDetached points the wrapper process's own stderr (append mode) at the same wrapper.stderr file that the data handler writes the child's stderr to. A stray wrapper-side write (e.g. a Node runtime warning) in the middle of an unfinished child line would split it, leaving the rest of a quoted secret on its own line with no name in front, which redaction then misses. No wrapper write happens today, so this is hardening. Also: the captured byte count resets on each claude-p resume while the file keeps its content, so the file can reach about 2 MiB before compaction (size only; the reader caps at 64 KiB).

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
