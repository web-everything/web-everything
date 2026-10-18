---
bornAs: x2sgweq
kind: story
size: 3
parent: "3007"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/pr-merge-gate.mjs", "we:scripts/conveyor/__tests__/merge-ai-prs-authority.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# The drain honours mergeGate.reviewAuthority (labels|both|ledger)

TOP PRIORITY (operator 2026-10-17): the missing slice, it is the switch. Today only the CI check reads mergeGate.reviewAuthority; the drain only logs a shadow comparison. Done when merge-ai-prs honours labels (unchanged), both (clears only if labels AND ledger clear) and ledger (review-label input dropped). Cards 3007 / 4284 cover the area. The A1 test plan maps every guarantee below to a named case and assertion.

Must: missing, errored, empty or truncated ledger input in both/ledger mode refuses the merge; it must never fall back to a clear label view. Missing or unknown authority settings default to labels, whose unavailable input also refuses. Tests: 'ledger read failures hold in both and ledger modes', 'missing authority defaults to labels', 'unknown value fails closed to labels', 'missing label input holds in labels and both modes'.

Must: ledger mode changes only the review-authority input. Docs, config, data, cards, code and mixed PRs still pass all independent CI, conflict, CodeQL, red-main and other merge safety checks. Test: 'ledger mode preserves independent safety gates for every input kind'.

## Acceptance

- [A1] **Executable** — npx vitest run we:scripts/conveyor/__tests__/merge-ai-prs-authority.test.mjs fails before and passes after. All cases in the following test plan belong to A1 and exercise the merge-ai-prs decision path with injected reads/settings. These are planned implementation tests, not tests delivered by this backlog-only PR.

### Test plan (A1)

Every row is owned by `we:scripts/conveyor/__tests__/merge-ai-prs-authority.test.mjs`.

| Named case | Observable assertion |
| --- | --- |
| 'labels mode unchanged' | Explicit labels mode preserves existing merge/hold outcomes, even when the shadow ledger disagrees. |
| 'both mode blocks when ledger holds' | Clear labels plus a ledger hold refuse the merge. |
| 'both mode blocks when labels hold' | A label hold plus a clear ledger refuses the merge. |
| 'both mode clears only when both clear' | Both complete inputs clearing permits the review gate; either hold refuses it. |
| 'ledger mode ignores labels' | With complete ledger evidence, clear/hold follows the ledger despite an opposite review-label result. |
| 'missing authority defaults to labels' | Missing file and absent key each resolve to labels and preserve a label hold. |
| 'unknown value fails closed to labels' | Unknown string and malformed setting values resolve to labels and preserve a label hold. |
| 'ledger read failures hold in both and ledger modes' | Parameterize missing file/row, empty result, thrown read, page-limit hit, buffer-limit hit and partial last row: each yields unknown, refuses the merge and never records agreement. |
| 'missing label input holds in labels and both modes' | Absent, errored or partial label reads refuse when labels are authoritative. |
| 'ledger mode preserves independent safety gates for every input kind' | Cross docs/config/data/cards/code/mixed PRs with red CI, conflict, CodeQL, red-main and other existing safety holds; each refuses even when ledger review clears. |
| 'other PR or head rows cannot clear current head' | Clear or hold rows for another PR or an older head leave the current PR/head result unchanged: they cannot clear a hold/missing evidence or turn complete clear evidence into a hold. |
| 'authority evaluation uses existing append-only ledger files' | Repeated evaluation creates no shared writer/file, preserves existing bytes and confines any writes to appends on existing ledger paths. |
| 'authority wiring preserves scoring clock and digest' | Switching review authority leaves scoring/version/clock unchanged; an injected scoring-version change resets the seven-day clock and produces a digest reset notice. |
| 'setting source logged' | Cascade overrides choose the expected value and log its actual source; default fallback logs the default source. |
| 'authority wiring does not flip settings or promote readiness' | Evaluation leaves settings bytes and promotion state unchanged, including when readiness is below the promotion bar. |

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not flip the setting itself; the flip to ledger waits on the readiness bar. A1: 'authority wiring does not flip settings or promote readiness'.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: reads internal ledger rows and settings only.
2. **Truncated reads** — unknown, ledger hold, never agree. A1: 'ledger read failures hold in both and ledger modes'.
3. **Shared state files** — appends only to existing ledger files, no new shared writer. A1: 'authority evaluation uses existing append-only ledger files'.
4. **Fail closed** — missing/invalid settings resolve to labels; unavailable authoritative evidence holds. A1: 'missing authority defaults to labels', 'unknown value fails closed to labels', 'ledger read failures hold in both and ledger modes', 'missing label input holds in labels and both modes'.
5. **Identity scoping** — rows keyed by PR and head. A1: 'other PR or head rows cannot clear current head'.
6. **State over time** — a scoring change resets the seven-day clock and appears in the digest; authority selection alone does not change scoring. A1: 'authority wiring preserves scoring clock and digest'.
7. **Who wrote it** — setting values carry their cascade source in the log. A1: 'setting source logged'.
