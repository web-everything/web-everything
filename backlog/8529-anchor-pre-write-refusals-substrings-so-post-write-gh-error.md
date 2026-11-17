---
bornAs: xwfgcs5
kind: story
size: 2
status: active
scaffoldedBy: "fix-6661"
dateScaffolded: "2026-11-10"
scope: ["we:scripts/operations/review-pr-io.mjs", "we:scripts/operations/__tests__/review-pr-io.test.mjs"]
dateOpened: "2026-11-10"
tags: []
related: ["6661"]
---

# Anchor PRE_WRITE_REFUSALS substrings so post-write gh error text cannot license a label replay

isPreWriteRefusal in we:scripts/operations/review-pr-io.mjs matches its PRE_WRITE_REFUSALS entries as unanchored substrings (e.g. 'renders a ', ', not OPEN', 'invalid --to'). The label sink treats a match as proof nothing was written and marks the effect failed for retry (notApplied). we:scripts/review-set-label.mjs reports post-write gh failures through ghErr, whose text is gh's own last stderr line, in the same error field. A post-write gh line containing one of those substrings would be read as pre-write and the retry could double-post the verdict comment. Fix: anchor each entry to the start of the CLI's own refusal text, as PR #6661 did for BODY_FILE_REFUSALS, and add a real-CLI no-gh-call test per entry. Found by the fix-6661 self-review.

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

sibling of the body-file refusal anchoring done in PR 6661
