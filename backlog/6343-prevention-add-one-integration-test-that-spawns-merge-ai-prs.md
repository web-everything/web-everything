---
bornAs: x6e3b7m
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/enqueue-on-event.mjs", "we:scripts/lib/fast-drain-scope.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs", "we:scripts/lib/__tests__/enqueue-on-event.test.mjs", "we:scripts/lib/__tests__/fast-drain-scope.test.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Add one integration test that spawns merge-ai-prs --only --this-repo --dry-run with a stubbed gh… (from web-everything/web-everything#5282 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:4600` — Add one integration test that spawns `merge-ai-prs --only --this-repo --dry-run` with a stubbed gh and a counter, and asserts the second run's commits-read count is 0 and the legacy-manifest git-fetch count is 0.
2. `we:scripts/lib/enqueue-on-event.mjs:640` — Add a test that a PR whose drain result is `skipped: <non-BLOCKED reason>` is not treated as busy for the same head signature. Consider a generic same-head, no-progress hold.
3. `we:scripts/lib/enqueue-on-event.mjs:733` — Test that an event arriving mid-drain for the same PR is retained and runs once after the active drain completes.
4. `we:scripts/lib/fast-drain-scope.mjs:40` — Add a test asserting that a manifest read after a failed fetch is not persisted. Persist only when the source rev is FETCH_HEAD.
5. `we:scripts/lib/enqueue-on-event.mjs:603` — Add a deterministic deferred-read shutdown test for both event and catch-up paths, asserting that resolving readPr after kill() never invokes spawnImpl.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5282@9a0aa5185f1107eee2063a3a6d4b908a4cb1c0ae

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
