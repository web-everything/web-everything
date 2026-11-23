---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/settings-registry-metadata.d/settings/allowedFiles.json", "we:scripts/operations/__tests__/build-priority-set.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a settings-registry check that fails on instant: true unless the key has a matching capacity-… (from web-everything/web-everything#7365 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/settings-registry-metadata.d/settings/allowedFiles.json:5` — Add a settings-registry check that fails on instant: true unless the key has a matching capacity-leaf entry. Failing that, add a review-lens note.
2. `we:scripts/operations/__tests__/build-priority-set.test.mjs:1` — Add a review-lens rule: every acceptance sentence must map to a test whose name or body mentions its observable outcome. Alternatively, parametrise the auto-pick selection tests over preview.
3. `we:scripts/operations/__tests__/build-priority-set.test.mjs:917` — Add the named acceptance test to the normal test gate, asserting the exact empty-list diagnostic and the selected IDs after injecting a pinned seed.
4. `we:scripts/operations/__tests__/build-priority-set.test.mjs` — Add deterministic acceptance tests using committed Git fixtures and the builder dry-run entry point, asserting the exact refusal message and selected card IDs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7365@3487fdb0c84ede21787963bb6c902542d48c1e11

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
