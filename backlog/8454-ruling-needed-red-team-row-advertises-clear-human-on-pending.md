---
bornAs: xbvfib5
kind: story
size: 2
status: active
scaffoldedBy: "fix-5482"
dateScaffolded: "2026-10-18"
scope: ["we:scripts/operations/operator-queue.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# RULING NEEDED red-team row advertises clear-human on pending or label-less PRs where it refuses

Found in PR #5482's fix self-review. redTeamRulingRow (we:scripts/operations/operator-queue.mjs) offers --to=clear-human as the not-real ruling for every held red-team break not under review:changes. After #5482, clear-human records that ruling only on a PR carrying review:accepted (it must not manufacture an acceptance). On review:pending or label-less PRs the advertised command refuses. Offer notReal only where it applies, or say the review must finish first.

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
