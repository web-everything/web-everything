---
bornAs: xsubqpu
kind: story
size: 2
status: active
scaffoldedBy: "fix-6606"
dateScaffolded: "2026-11-12"
scope: ["we:scripts/lib/review-red-team-on-skip.mjs", "we:scripts/lib/red-team-check-run.mjs"]
dateOpened: "2026-11-12"
tags: []
related: ["6606"]
---

# Carried red-team check publisher in review-red-team-on-skip writes as the daemon role and reads appId from an env the daemon never sets (PR 6606 after 6535 restack)

Carried red-team check publisher in review-red-team-on-skip writes as the daemon role and reads appId from an env the daemon never sets (PR 6606 after 6535 restack). Context from the finding: found by the self-review of the PR 6606 restack onto PR 6535; restack forbids non-conflict edits.

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

found by the self-review of the PR 6606 restack onto PR 6535; restack forbids non-conflict edits
