---
bornAs: xt9t2i2
kind: story
size: 3
status: active
scaffoldedBy: "fix-6529"
dateScaffolded: "2026-11-09"
scope: ["we:scripts/lib/jury-core.mjs"]
dateOpened: "2026-11-09"
tags: []
related: ["6529"]
---

# Gate reader still accepts an unstamped human-actor operator ruling posted by trusted automation

The referral-ruling gate reader (jury-core parseOperatorRulingComment, the poster check) binds an operator ruling to its author only when the record carries a poster stamp. An unstamped (legacy) human-actor ruling authored by trusted automation is still accepted, kept for PR 5925 compatibility. So the actor binding lives only in the sanctioned writer, not at the gate. Ruled as debt by the operator on PR 6529 (judge sweep 2026-11-09): decide a cutoff (by createdAt or a migration) after which unstamped human-actor rulings from automation hold instead of clear, with red-first tests for both sides of the cutoff.

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

raised as an advisory finding on PR 6529 round 4 and ruled as debt
