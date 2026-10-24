---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/record-red-team-ruling-io.mjs", "we:scripts/operations/__tests__/record-red-team-ruling.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# card filing exclusive across coordination roots

The red-team ruling card filing (we:scripts/operations/record-red-team-ruling-io.mjs) is exclusive through the action-store claim only within ONE coordination root. Two invocations in different roots can both file a card for the same ruling. Accepted as degraded-not-harmful by the operator (separate roots are isolated environments), audit finding from the slice 3 PR. Make filing exclusive across roots, e.g. by an authoritative marker on the PR thread that is claimed atomically.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/operations/__tests__/record-red-team-ruling.test.mjs` has a test where two rulings with different coordination roots produce exactly one card; it fails before and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] does not change the single-root action-store claim; only adds cross-root exclusion.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: no new text is parsed beyond the existing marker handling.
2. **Truncated reads** — a truncated marker proves nothing and is treated as absent.
3. **Shared state files** — the cross-root marker lives on the PR thread, claimed atomically.
4. **Fail closed** — an unreadable marker refuses to file.
5. **Identity scoping** — keyed on repo, PR, head and break key.
6. **State over time** — a new head starts a new key.
7. **Who wrote it** — only a human-operator-authored marker counts.
