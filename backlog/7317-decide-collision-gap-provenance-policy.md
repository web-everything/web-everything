---
bornAs: xpg1c2d
kind: task
status: open
scope: ["we:scripts/backlog/renumber-collisions.mjs", "we:scripts/backlog.mjs", "we:scripts/lib/__tests__/card-number-allocator.test.mjs", "we:scripts/backlog/__tests__/number-at-birth-cli.test.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Protect historical card numbers when selecting collision gaps

PR #5958 review (2026-10-26), correctness finding 3: remote-backed yield and planRenumber choose a free gap below the reservation frontier. Current trees and reservation refs cannot distinguish a never-issued gap from a deleted legacy card number. Require explicit opt-in or durable provenance before reusing a historical number. Test a deleted legacy number lacking reservation refs, default refusal or a fresh target, and opt-in behavior. Preserve atomic target claims and immutable bornAs and reserved sources. Include planBaseCollisionHeal, whose gap filling predates this PR.

## Acceptance

- [A1] **Executable** — Run the collision planner and number-at-birth CLI suites with a historical deleted legacy card whose number has no reservation ref. Default allocation must not reuse that number without provenance; an explicit opt-in case pins any permitted reuse and still claims before writing.

## Non-goals

- [N1] Reconstruct the full numbering ledger or renumber existing immutable identities.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no new free-text parser; reuse existing numeric ID validation.
2. **Truncated reads** — Missing provenance must not be treated as a never-issued number.
3. **Shared state files** — Preserve atomic create-only claims when two healers select the same target.
4. **Fail closed** — Absent safe targets require manual repair; reserved or bornAs sources always refuse.
5. **Identity scoping** — Include deleted legacy identities as well as currently materialized cards.
6. **State over time** — Cover deletion before reservation refs existed and repeated heals.
7. **Who wrote it** — Reuse existing caller permissions and guarded writers; no new endpoint.
