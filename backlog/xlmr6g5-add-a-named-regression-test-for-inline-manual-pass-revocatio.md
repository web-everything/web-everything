---
kind: story
size: 2
status: open
dateOpened: "2026-11-13"
tags: []
related: ["we:backlog/8176-limit-the-manual-r247-pass-note-shape-to-the-operator-login.md"]
---

# Add a named regression test for inline manual-pass revocation in accept-carry-forward replay

Add a named regression test to we:scripts/lib/__tests__/accept-carry-forward.replay.test.mjs covering inline manual-pass revocation, which the #6713 advisory (line 994) found has no named test.

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

same accept-carry-forward manual-pass surface; adds the named regression test the 6713 advisory found missing

8176 limits the note shape; this adds a named test for revocation
