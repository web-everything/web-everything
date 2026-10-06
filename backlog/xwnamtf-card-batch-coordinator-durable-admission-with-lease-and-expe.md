---
kind: story
size: 5
parent: "4703"
status: open
blockedBy: ["xowd9o9"]
scope: ["we:scripts/operations/card-batch.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/operations/__tests__/card-batch.test.mjs", "we:scripts/operations/__tests__/card-batch-io.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Card batch coordinator: durable admission with lease and expected-head, one commit per card

The #4703 coordinator admission half. A producer submits one already-written card (path, card id, idempotency key, base sha, delivery kind, source repo/PR/head). The coordinator takes a per (repo, kind) lease with expiry, checks the remote batch ref still equals the recorded head, appends exactly one commit for the card, pushes fast-forward only (no force), and records membership (card id, key, commit sha, source) in a durable state file BEFORE acknowledging. A retry with the same key returns the existing membership and never adds a second commit; a crash between commit, push and record is reconciled against the remote ref. Lease conflict, head mismatch, unknown policy or an ineligible change set is refused with a reason. The lane is not held across the age window: state lives in the remote ref plus the state file.

## Done when

1. **Executable** — `npx vitest run` over we:scripts/operations/__tests__/card-batch.test.mjs and we:scripts/operations/__tests__/card-batch-io.test.mjs passes (strip the `we:` prefix to execute). The IO suite uses temporary REAL git repos with a bare remote and an injected clock, and asserts resulting commits, trees and state files, not mocked call counts.
2. **Must** — two concurrent producers admitting different cards end with both cards on the remote batch ref, exactly one commit each, card bytes identical to what was filed.
3. **Must (idempotent retry)** — re-admitting the same idempotency key returns the original membership and adds no commit; a crash injected after commit-before-push, after push-before-record, and after record each recover to exactly one commit per card.
4. **Must (refuse on error)** — an expired lease is taken over; a live lease held by another owner, a remote head that differs from the recorded head, an unknown or invalid policy, a disabled kind, or an ineligible change set (per the eligibility check) each refuse with a named reason and leave the ref and state untouched.
5. **Must** — no push uses `--force` or `--force-with-lease`; the expected-head guard is a fast-forward-only push plus the recorded-head check.
6. **Executable** — `npm run check:standards` green.

## Build checklist

- [ ] we:scripts/operations/card-batch.mjs: pure planner (admit decision, membership merge, reconcile plan) over the policy core.
- [ ] we:scripts/operations/card-batch-io.mjs: state file per (repo, kind) under the workspace `.operations/card-batch/` dir, lease via exclusive-create lockfile with owner + expiry, git adapter (fetch, commit one path, ff-only push), injected clock.
- [ ] Batch ref naming: `lane/card-batch-<kind>-<n>` (unique per batch; never reused after seal).
- [ ] Membership record fields: card id, idempotency key, commit sha, source `{repo, pr, head}`, admittedAt.
