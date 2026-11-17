---
bornAs: x938xts
kind: story
size: 2
status: active
scaffoldedBy: "fix-5461"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/lib/operator-send-backs.mjs", "we:scripts/conveyor/review-detail.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Send-back header matching misses bold and human-review shapes in CHANGES_RE and operator-send-backs

Found while fixing PR #5461 (card xtbxcp8). Real operator comments (e.g. PR #745, by chalbert) use the bold header '🔁 **human review — changes requested**'. The shared CHANGES_RE in we:scripts/conveyor/fix-context-pack.mjs:109 (now also used by the scope fence's operatorScope) does not match it, so scope-removed markers in such comments are silently ignored. we:scripts/lib/operator-send-backs.mjs:21 only matches '🔁 review — changes requested', so a human-review send-back never becomes an operator send-back for the fixer brief. we:scripts/conveyor/review-detail.mjs:34 also misses the bold shape. Advisory: move CHANGES_RE into a small leaf module so the fence keeps a light import graph.

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
