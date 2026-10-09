---
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/sibling-clone.mjs", "we:scripts/lib/merge-queue-hook.mjs", "we:scripts/lib/drain-skip-reasons.mjs", "we:scripts/settings/merge-queue.json"]
dateOpened: "2026-10-09"
tags: []
---

# Drain merge-queue refresh: provision the missing cross-repo sibling clone (plateau-app #217 never merged)

plateau-app PR #217 (accepted, CLEAN) was skipped every drain pass: merge-queue refresh -> skipped-remote, no plateauapp/plateau-app clone in the resident drain's pool. Fix: the refresh provisions the sibling clone on demand (we:scripts/lib/sibling-clone.mjs), named mq-* skip kinds, per-repo nonCodePaths (plateau-app: docs/, reports/). Clone not update-branch API because the acceptance re-check on the moved head needs a checkout. PR lane/mq-cross-repo-refresh, stacked on #4624.

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
