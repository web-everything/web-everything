---
kind: story
size: 2
status: active
scaffoldedBy: "fix-4688"
dateScaffolded: "2026-10-09"
blockedBy: ["3930"]
dateOpened: "2026-10-09"
tags: []
---

# review-ledger-check scores a PR whose GitHub facts were only partly read as agree, so a day can come out clean on missing evidence

deriveRow marks a PR unreadable only for probe errors starting with GitHub PR. Other readPrFacts failures (head/comments unavailable, head changed during probes, check rollup truncated, older comments unavailable, comment and timeline caps) are ignored, so a partly read PR can score agree and the day clean in the history query. Treat any probe error as unreadable, or record it as incomplete evidence. Found in PR 4688 self-review.

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
