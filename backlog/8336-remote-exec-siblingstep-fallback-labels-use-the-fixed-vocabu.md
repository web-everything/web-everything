---
bornAs: x942zaa
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-exec.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# remote-exec siblingStep fallback labels: use the fixed vocabulary dir-unsafe/git-evidence/dirty/ls-files/head-changed

we:scripts/readiness/remote-exec.mjs:855-858 (2026-11-15 09:20 ET, LOW, after #6873 lands): siblingStep fallback labels (fixed vocabulary dir-unsafe, git-evidence, dirty, ls-files, head-changed; also :1581 and :1313) are routed but not in #6880; needs a main-based lane.

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
