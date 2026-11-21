---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/verify-lane.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Route all marker writes through one helper (or make writeMarker itself add local when FORCE_LOCAL… (from web-everything/web-everything#7188 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/verify-lane.mjs:619` — Route all marker writes through one helper (or make writeMarker itself add `local` when FORCE_LOCAL), so a new write site cannot omit the policy. Add a source-level test that every writeMarker call passes through it.
2. `we:scripts/verify-lane.mjs` — Reject `*`, `?` and `[` outside quotes in the tokenizer, so any glob makes the parse incomplete and the command is refused. Add a glob case to the `commandShapes` table.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7188@b8a53d02f358af5397fc84a51c6f4bfaeb0bb475

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
