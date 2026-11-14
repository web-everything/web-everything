---
kind: story
size: 3
status: active
scaffoldedBy: "fix-6787"
dateScaffolded: "2026-11-14"
scope: ["we:scripts/lib/drain-red-team-evidence.mjs", "we:scripts/lib/red-team-sealed-status.mjs"]
dateOpened: "2026-11-14"
tags: []
related: ["6787"]
---

# Red-team evidence reader reports a finished resumed status as never recorded

PR 6787 red team: drain-red-team-evidence projects recorded=false and seatRecorded=false for a finished status whose result is a bare resumed, so callers treat a head with stored red-team evidence as never run. The not-owed publish paths now also read the seal from the status itself, but the projection should say recorded. Same class: readStoredRedTeamStatus returns null (absent) instead of unreadable for a malformed repo, pr or head key, which a seal reader then reads as no seal.

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

red-team break on PR 6787

new: found by the PR 6787 red-team round
