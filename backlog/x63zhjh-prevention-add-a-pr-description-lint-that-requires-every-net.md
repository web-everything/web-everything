---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/evidence-readers.mjs", "we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs", "we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/evidence-readers.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/overlay-main-sync.test.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Prevention — Add a PR-description lint that requires every net-changed path outside the declared 'Files:' list… (from web-everything/web-everything#7351 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/evidence-readers.mjs:49` — Add a PR-description lint that requires every net-changed path outside the declared 'Files:' list to be named in the description. File this as a backlog item.
2. `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:713` — Add a branch-coverage threshold for changed lines in daemon-rebuild modules, or a review-lens checklist item for every new conditional branch.
3. `we:scripts/lib/daemon-rebuild/evidence-readers.mjs:97` — Add a table-driven negative test that drops or flips each conjunct of the new accept-predicate. Longer term, a lint or standards rule could flag newly added accept-branches in strict readers that have no matching reject fixture.
4. `we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:926` — File a card for an integration test: a replay in which a completed main-sync makes the stale-code guard pass for a review dispatch. Add a check that each Acceptance bullet on a backlog card names a test or an explicit live-proof waiver.
5. `we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs:1333` — Add a deterministic boundary test with both configurable limits above 50 and assert the actual batch sizes.
6. `we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs:1310` — Add a deterministic integration test asserting the daemon's adopted SHA and successful dispatch after chunked synchronization.
7. `we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs` — Add a deterministic boundary test with both the override and fast-file limit above 50 and assert that no chunk exceeds 50.
8. `(no file cited)` — Add a deterministic integration test named 'daemon adopts current main after chunked overlay sync and permits dispatch', asserting the adopted revision and absence of the stale-code refusal.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7351@47d910d100dd4ec00525aad88762049d2ee7068c

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
