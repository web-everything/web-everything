---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/github-app-identity.mjs", "we:scripts/lib/review-log-claims.mjs", "we:scripts/lib/drain-blocked-reason.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevent drain verdict-heading and gh-permission drift found in the stale merge-gate review

Owed prevention from the PR 7485 review. (1) The merger role is declared with actions read in we:scripts/lib/github-app-identity.mjs, so the drain's gh run rerun may be refused when it runs as the merger App: confirm live, then decide the grant, and add a check:standards gate mapping gh write verbs to the permission each caller role needs. (2) Share one review verdict-heading classifier (we:scripts/lib/review-log-claims.mjs already lists headings) and forbid new literal prefix lists; we:scripts/lib/drain-blocked-reason.mjs now holds its own copy. (3) Run a mutation check on new suppression guards so each clause is pinned by a test.

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
