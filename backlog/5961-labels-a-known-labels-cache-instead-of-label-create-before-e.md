---
bornAs: xqce2qz
kind: story
size: 1
status: open
scope: ["we:scripts/lib/ensure-label.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Labels: a known-labels cache instead of label create before every edit

Held finding 227 (coroner-5). 4,118 label create calls in 12 h (merge-ai-prs 3,083, review-daemon 709, fix-procedure 134, pr-land 111); 295/h after the 18:30 ET fix. Each is an idempotent ensure-exists. Fix: a per-repo known-labels cache (refreshed daily or on a 422 label-not-found); create a label only when the edit fails for a missing label. Evidence: calls.jsonl op label create.

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
