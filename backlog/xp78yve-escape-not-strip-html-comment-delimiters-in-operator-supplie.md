---
kind: story
size: 3
status: active
scaffoldedBy: "fix-5169"
dateScaffolded: "2026-10-13"
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/promote-draft-pr-dispatch.mjs", "we:scripts/operations/record-referral-ruling.mjs", "we:scripts/operations/completion-record.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Escape, not strip, HTML-comment delimiters in operator-supplied prose outside operator controls

PR #5169 replaced strip-based comment filtering in we:scripts/operations/operator-controls.mjs with full angle-bracket escaping after CodeQL flagged incomplete multi-character sanitization and a bad HTML filtering regexp. Same class remains at: we:scripts/operations/land-prevention-card.mjs (escapes only the opener), we:scripts/operations/promote-draft-pr-dispatch.mjs (escapes only the opener in quoted reason), we:scripts/operations/record-referral-ruling.mjs (escapes opener and plain closer, misses the bang closer), we:scripts/operations/completion-record.mjs (regex strip). Edge cases: nested delimiters re-forming after one pass, the bang closer, partial openers/closers, CR/U+2028 line splits. Escape &, <, > in every untrusted string rendered into a comment that trusted marker readers scan; add an integration test per site proving parseReviewedSha / parseLatestHumanClearedSha stay null.

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
