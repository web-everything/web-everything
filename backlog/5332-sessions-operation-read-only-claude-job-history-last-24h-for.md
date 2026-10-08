---
bornAs: x4z1vez
kind: story
size: 3
status: active
scaffoldedBy: "sessions-s2"
dateScaffolded: "2026-10-08"
scope: ["we:scripts/operations/sessions.mjs", "we:scripts/operations/sessions-io.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# sessions operation: read-only Claude job history (last 24h) for the Plateau sessions page, review history gap logged (S2)

Slice S2 of cards-to-file 128. New read-only sessions operation in we:scripts/operations/run.mjs: merges live-work rows with ended Claude jobs from the harness jobs folder inside the ended-within window, folds subagents into a count, dedupes live vs ended, reports degraded[]. Review-completion history waits on D6 (shared run-record store) and is logged as a degraded gap.

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
