---
bornAs: xsd53zr
kind: story
size: 2
status: active
scaffoldedBy: "fix-5744"
dateScaffolded: "2026-10-20"
scope: ["we:scripts/conveyor/liveness-sweep-core.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# liveness-sweep lastReview reads red-team gate markers unanchored and without an author check

we:scripts/conveyor/liveness-sweep-core.mjs lastReview matches '<!-- we:red-team-gate pr= rev=' anywhere in any comment body (unanchored, case-insensitive, short revs, no isTrustedMarkerAuthor). Any commenter can post a forged marker and reset the last-review stall clock, hiding a stall alert (notify-only). Reuse parseRedTeamGateMarker + isTrustedMarkerAuthor. Found by the PR #5744 fix self-review.

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
