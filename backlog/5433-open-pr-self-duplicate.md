---
bornAs: xbdzt01
kind: story
size: 2
status: open
scope: ["we:scripts/operations/open-pr-io.mjs", "we:scripts/operations/__tests__/open-pr.test.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# open-pr duplicate-card check flags a PR's own cards as duplicates of itself

open-pr passes --ref (never --branch) to pr-land, but the duplicate-bornAs advisory reads arg('branch'), so the self-exclusion is always empty and updating PR #4478 warns every card it adds is 'also in #4478'. Fix: exclude the PR being opened (its head ref) from the open-PR scan; a card duplicated in a different open PR must still warn.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
