---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# drain park/skip/land comment dedupe reads one page of comments but marks the read complete

Flow-sim gap R4-G8, class K17 (partial page read as complete). Failing input: PR with >= 100 comments; a drain reason comment (kind, reason) was posted after comment 100. next drain pass for that PR via postDrainReasonComment without `preread` (call sites we:merge-ai-prs.mjs:4935, 6233, 6354, 6466, 6489, 6814) or upsertHeldParkComment (:5265). Cited: we:scripts/merge-ai-prs.mjs:4775-4780. Soak-break sketch: double-act. A duplicate park/skip/land comment each pass (the #4017 spam shape), and for upsert a second 'held' comment instead of an edit. Per the repo's own statement that `gh pr view --json comments` returns one page.

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
