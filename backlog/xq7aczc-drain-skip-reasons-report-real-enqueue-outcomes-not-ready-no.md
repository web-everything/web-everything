---
kind: story
size: 3
status: active
scaffoldedBy: "drain-fastdrain-holds"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Drain skip reasons report real enqueue outcomes, not ready-not-reached

Note: build after #5518, #5492, #5480 and #5462 land (we:scripts/merge-ai-prs.mjs is occupied).

buildSkipReasons in we:scripts/lib/drain-skip-reasons.mjs labels every merge-verdict PR that no bucket reported as ready-not-reached ("cap, budget or dependency order"), a guess. It takes no enqueue outcomes, so PRs refused at enqueue (red-team-pending, merge-lock held, numbering before enqueue) get the wrong label. Pass the enqueue outcomes in and report the real reason.

## Acceptance

- [A1] **Executable** — vitest run on the skip-reasons test: a PR refused with red-team-pending, merge-lock held or numbering reports that reason, not ready-not-reached. Fails before, passes after.

## Non-goals

- [N1] No change to which PRs are enqueued.

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
