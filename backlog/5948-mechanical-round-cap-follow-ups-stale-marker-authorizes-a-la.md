---
bornAs: x8rsopp
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs", "we:scripts/conveyor/reconcile-pass.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# mechanical-round-cap follow-ups: stale marker authorizes a later round; trust before regex

Held finding 240 (2026-10-11, from #4770 approval). (a) PRIORITY: an old mechanical marker can authorize a later ordinary round (we:scripts/conveyor/mechanical-round-cap.mjs ~:346), same class as the operator block; (b) isReviewVerdictComment runs the backtracking MECHANICAL_ATTRIBUTION regex before isTrustedMarkerAuthor (~:88): check trust first; (c) test the we:scripts/conveyor/reconcile-pass.mjs ~:1375 IO gating; (d) tests for git-failure and off-base-parent refusals. Related but distinct: #5822 (proof permits unrelated edits) and #5837 item 3.

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
