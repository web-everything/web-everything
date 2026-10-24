---
bornAs: x5xhvss
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/card-group.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# card-group: rebase a BEHIND combined PR under drain-direct; fail closed on unreadable group state

Follow-up to #5762 (R71). Two confirmed findings. (1) we:scripts/merge-ai-prs.mjs ~5490: the in-group rebase skip skips every group member including the COMBINED PR whatever the merge strategy, so under drain-direct a BEHIND combined PR is never rebased, and reconcile only dissolves a group on CONFLICTING, not BEHIND. (2) we:scripts/lib/card-group.mjs: inaccessible group state is treated as absent, releasing source holds; it must fail closed (re-check on the live head).

## Acceptance

- [A1] **Executable** — a scoped test in we:scripts/merge-ai-prs.mjs tests: a BEHIND combined PR under drain-direct is rebased, and unreadable group state in we:scripts/lib/card-group.mjs keeps source holds.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] n/a: nothing excluded beyond the two findings.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text input.
2. **Truncated reads** — n/a: no new reads.
3. **Shared state files** — group state file read must not be treated as absent when unreadable.
4. **Fail closed** — unreadable group state keeps the source holds (fail closed).
5. **Identity scoping** — n/a: no identity change.
6. **State over time** — a group that goes BEHIND over time is rebased or dissolved.
7. **Who wrote it** — n/a: no authorship change.
