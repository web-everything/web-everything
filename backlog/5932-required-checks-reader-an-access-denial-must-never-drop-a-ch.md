---
bornAs: xyn4tt0
kind: story
size: 2
status: open
scope: ["we:scripts/lib/required-status-checks.mjs", "we:scripts/lib/__tests__/"]
dateOpened: "2026-10-12"
tags: []
---

# Required-checks reader: an access denial must never drop a check seen live

From the PR #4924 red-team break (operator ruled card, 2026-10-12): in we:scripts/lib/required-status-checks.mjs (~line 288) a later access denial can fall back to the declared policy and drop a required check an earlier live read observed, letting red CI pass the review gate. On denial keep the last LIVE set (union with any partial read); never fall back to a set missing a previously observed check; fail closed if neither exists. Harmless today only because the declared list equals the live ruleset.

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
