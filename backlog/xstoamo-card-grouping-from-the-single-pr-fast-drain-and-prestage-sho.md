---
kind: story
size: 5
parent: "xym8nt4"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/card-group.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Card grouping from the single-PR fast drain (and prestage shortcut) before single enqueue

Fast drains (--only, incl. the from-green-event prestage shortcut) never call cardGrouping.form and enqueue same-card accepted PRs singly (#5672 #5700 #5655 #5653 on 2026-10-20). They list only the target, so siblings must come from the shared open-PR context; admission must reuse cardGroupAdmission (preEnqueueHold forGroup + revalidateFresh) per member. Option: a bounded hold of a card-only target while an admitted same-card sibling exists, then form in the fast drain under the land mutex. Prove on a live same-card pair.

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
