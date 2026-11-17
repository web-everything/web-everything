---
bornAs: xudy1py
kind: story
size: 2
status: active
scaffoldedBy: "fix-6606"
dateScaffolded: "2026-11-11"
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs"]
dateOpened: "2026-11-11"
tags: []
related: ["6606"]
---

# Accept carry-forward treats a verdict-carry comment that carries a policy-clear red-team result as an unknown later comment

Accept carry-forward treats a verdict-carry comment that carries a policy-clear red-team result as an unknown later comment. Context from the finding: sibling of the PR 6606 round-5 red-team break (carried policy-clear refused by a completeness check).

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

sibling of the PR 6606 round-5 red-team break (carried policy-clear refused by a completeness check)
