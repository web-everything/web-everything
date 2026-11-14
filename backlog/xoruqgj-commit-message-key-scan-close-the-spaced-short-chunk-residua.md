---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/remote-git-bundle.mjs", "we:scripts/readiness/__tests__/remote-git-bundle.test.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Commit-message key scan: close the spaced short-chunk residual

Reinforce later. The commit-message key rule (we:scripts/readiness/remote-git-bundle.mjs) refuses any 32+ token run when the key label words appear, but a key hand-split into spaced chunks under 32 characters still passes. Accepted R907/R903: not a real credential format and blob scanning still applies. Consider a joined-length check over token-only words.

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
