---
bornAs: xe18exv
kind: story
size: 1
status: active
scaffoldedBy: "fix-6622"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/review-status-tag.mjs"]
dateOpened: "2026-11-11"
tags: []
related: ["6622"]
---

# PR status label reads the red-team disposition without a repo, so the stored-evidence seal is never read there

we:scripts/conveyor/pr-status-label.mjs calls redTeamQueueReason(subject) with a subject built in we:scripts/conveyor/review-status-tag.mjs that carries no repo, so readSealedStatus returns null and the seal is skipped (fail open for that status label only; merge paths still hold). Pass the repo, and consider making a missing repo with a valid PR and head read as unreadable in we:scripts/lib/red-team-sealed-status.mjs.

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

PR 6622 seal reader needs the repo; this caller omits it
