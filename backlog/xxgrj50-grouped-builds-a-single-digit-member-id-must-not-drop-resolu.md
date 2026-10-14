---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/operations/__tests__/"]
dateOpened: "2026-10-14"
tags: []
---

# Grouped builds: a single-digit member id must not drop resolution credit for the whole group

Operator ruling 'card' on PR #5187 red-team break (2026-10-14 ~17:00 ET). we:scripts/operations/deliver-item-wrapper.mjs ~2620: parseGroupMembers accepts any digit count, so a member like #7 is emitted in 'Resolves #7, #7102', but the declaredResolvedIdsFromPr whole-line regex only accepts 2-5 digit ids, so the line fails and every member (including #7102) loses resolution credit. Fix: one shared id pattern for emit and parse, and a per-id parse so one bad id cannot void the line. Test: lead 7101 with members 7 and 7102 resolves both.

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
