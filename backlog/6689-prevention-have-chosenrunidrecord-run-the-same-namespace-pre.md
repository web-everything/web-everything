---
bornAs: x38y8ja
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/cli-adapter.mjs", "we:scripts/operations/run-store.mjs", "we:scripts/operations/__tests__/cli-adapter.test.mjs", "we:scripts/operations/__tests__/run-store.test.mjs"]
dateOpened: "2026-10-18"
tags: []
---

# Prevention — Have chosenRunIdRecord run the same namespace predicate as writeRun (export a shared reviewRunIdA… (from web-everything/web-everything#5520 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/cli-adapter.mjs:1295` — Have `chosenRunIdRecord` run the same namespace predicate as `writeRun` (export a shared `reviewRunIdAllowed(op, id)`), and add a CLI-level test for each rejection shape.
2. `we:scripts/operations/run-store.mjs:180` — Add deterministic journal recovery tests with controlled interruption and append interleavings, and require named coverage when introducing persistent recovery mechanisms; this specific guard still needs filing.
3. `we:scripts/operations/run-store.mjs:231` — Invalidate negative classifications when file metadata changes and add a deterministic replacement regression through the real readers and re-stamp writer.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5520@8e3e673fdf411f95398b9b11602f04b149176f8a

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
