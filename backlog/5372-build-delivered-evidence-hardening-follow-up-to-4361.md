---
bornAs: xidoch3
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/build-delivery-evidence.mjs", "we:scripts/conveyor/build-dispatch-orphan-adopt.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Build-delivered evidence hardening (follow-up to #4361)

Harden build-delivery evidence after PR #4361: (1) we:scripts/conveyor/build-delivery-evidence.mjs:52 a prep or scope PR with an unknown title shape is read as a real build; (2) we:scripts/conveyor/build-delivery-evidence.mjs:96 an unresolved card stays blocked by its old merged PR unless dateOpened is hand-reset; (3) we:scripts/conveyor/build-delivery-evidence.mjs:164 the PR lookup omits retry-branch shapes (suffixed lane branches); (4) the review daemon ruling-dispute finding on #4361: we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:393 (missing or unrecognized job states treated as proof a session is alive), ruled block earlier, reported again after 3 misses on the new head; re-verify against current head and close with before/after proof.

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
