---
bornAs: xko7l6e
kind: story
size: 3
status: active
scaffoldedBy: "fix-5996"
dateScaffolded: "2026-10-29"
scope: ["we:scripts/lib/drain-poison-guard.mjs", "we:scripts/lib/__tests__/drain-poison-guard.test.mjs"]
dateOpened: "2026-10-29"
tags: []
---

# bornAs pre-enqueue guard: close remaining guard-vs-loader gaps (symlinked cards, moving main ref, added-side read bound, PR-controlled name in refusal comment)

Found by the PR #5996 fix self-review, outside its 2-round cap. (1) A symlinked backlog card: git show returns the link target text but the loader follows the link, so a main symlink to a card with a duplicate bornAs is admitted; read blob modes and hold on mode 120000. (2) origin/main is re-read by name for diff, grep and each show; a concurrent fetch can move it mid-check; rev-parse once and pin the sha. (3) The added side runs one git show per added card with no bound; cap and hold like the main side. (4) The refusal comment embeds the PR-controlled card path; fence or sanitize it (mentions, markdown links). (5) Escaped hash spellings (\x78…) hide from any text search; decide whether to hold on an escape-bearing bornAs line.

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
