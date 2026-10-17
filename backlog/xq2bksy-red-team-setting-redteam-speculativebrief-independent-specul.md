---
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-extra-seats.mjs", "we:scripts/lib/review-speculative-red-team.mjs", "we:scripts/settings/review.json"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.speculativeBrief=independent: speculative brief from diff and card only

Build after #5482 land (it holds we:scripts/operations/review-extra-seats.mjs). 412 of 788 accept-path speculative red-team passes (52%) were thrown away as stale ('the jurors raised N finding(s) the speculative brief could not carry') and re-run: about 412 wasted calls and 1,650 codex minutes per 7 days; only 38% of accepts got the zero-wait benefit. Spec: redTeam.speculativeBrief = independent (default). The speculative start uses a brief built only from the diff and the card, never from juror findings, so a later juror change does not invalidate it. The result is keyed to the head and reused when that head is accepted. A head move still invalidates it. Operator 2026-10-17: Ok. Never weaken a hold. Tests first, run red, one per setting. A cascade setting with its source logged.

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
