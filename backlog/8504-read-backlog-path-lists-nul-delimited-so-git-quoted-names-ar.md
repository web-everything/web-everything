---
bornAs: xodqljt
kind: story
size: 3
status: active
scaffoldedBy: "fix-6538"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/lib/card-number-allocator.mjs", "we:scripts/lib/nnn-collision-heal.mjs", "we:scripts/lib/numbering-carry.mjs", "we:scripts/lib/drain-followup-job.mjs", "we:scripts/backlog-renumber-collisions.mjs", "we:scripts/backlog.mjs", "we:scripts/lane-drain.mjs", "we:scripts/operations/deliver-item-wrapper.mjs"]
dateOpened: "2026-11-09"
tags: []
related: ["6121"]
---

# Read backlog path lists NUL-delimited so Git-quoted names are not missed

git ls-tree/ls-files without -z C-quote non-ASCII or special-character names (a café card name becomes a quoted octal-escaped line), so any backlog-path regex over line output silently skips them: numeric floors come out too low (number reuse) and hash-card checks miss pending cards. PR 6538 fixed the card number ledger, queue branch numbering and the drain readFiles probe. Sweep the remaining producers listed in scope to -z with NUL splitting, each with a real-git test using a non-ASCII card name.

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

## Duplicate admission

same defect class fixed in-scope on PR 6538
