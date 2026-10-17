---
bornAs: xuh9f10
kind: story
size: 2
status: active
scaffoldedBy: "prevention-note-carry"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/approval-prevention-notice.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-17"
tags: []
---

# Human-clearance carry tolerates the approval-prevention notice

The human-clearance carry refuses when the approval-prevention filer notice (marker comment posted as the operator) sits between the clearance and a numbering-only commit, as seen on PR 5403. Recognise that exact notice shape (reusing the marker parser, trusted author) as a known machine body; any appended prose or untrusted author stays non-tolerable. Tests first, red then green.

## Acceptance

- [A1] **Executable** — `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/human-clearance-carry.test.mjs` fails before this item lands and passes after.

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
