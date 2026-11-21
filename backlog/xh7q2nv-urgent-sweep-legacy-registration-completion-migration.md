---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/urgent-sweep.mjs", "we:scripts/operations/__tests__/urgent-sweep.test.mjs", "we:scripts/operations/__tests__/hot-patch-singleton.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Urgent sweep: migrate in-flight legacy registration-completion state

Track the legacy-ledger migration suggestion from PR #7227's 2026-11-21 advisory separately from that PR's runtime changes. Replay pre-field urgent loads through merge or retirement and distinguish historical records from new intents that require registration completion. This is follow-up work, not a change to the PR's current not-real ruling.

## Source and prevention owed

- Review: web-everything/web-everything#7227, head `d52ac6f729893b0f27a7924d872e8ae6e10b38ad`, correctness/correctness at `we:scripts/operations/urgent-sweep.mjs:296`; also the later-round codex-correctness card suggestion at `we:scripts/operations/urgent-sweep.mjs:269`.
- The source currently uses `complete.has(id)` for absent-registration settlement and adoption. Existing tests at `we:scripts/operations/__tests__/urgent-sweep.test.mjs:151` deliberately retain monitoring for legacy non-terminal receipts. The advisory's requested prevention is a migration fixture covering every pre-field non-terminal state; any behavioral migration belongs to this follow-up and must preserve the new-intent registration race guard.
- Proposed migration: treat a missing `registrationCompletionRequired` field on a historical load as completion not required throughout the sweep. Keep an explicit completion requirement on new intents. Prove ancestry and removal/adoption independently; absence of the field alone must not prove that the daemon stopped running a patch.

Idempotency key (do not edit): advisory-prevention-key:web-everything/web-everything#7227@d52ac6f729893b0f27a7924d872e8ae6e10b38ad:legacy-migration

## Acceptance

- [A1] **Executable** — Add `legacy ledger migration replays every non-terminal state through merge or retire` to `we:scripts/operations/__tests__/urgent-sweep.test.mjs`. Use literal pre-field fixtures with no completion record and no receipt, `monitoring-green`, or `unloaded-pending-adoption`. Cross ordinary and hot-patch loads with merge/retirement paths. Assert eventual `settled-unregistered` or `unloaded-adopted` only after ancestry and adoption evidence allows it, and no spurious completion-unproven escalation after fifteen minutes.
- [A2] **Executable** — Add `new intents still require registration completion after legacy migration` to the same suite. Pause registration after intent append, sweep repeatedly, then complete registration. Assert no terminal settlement before completion, including when an old-shaped receipt is present. Cover explicit `registrationCompletionRequired: true` and contradictory receipt fields.
- [A3] **Executable** — Add `legacy migration preserves monitoring until withdrawal is adopted` to the same suite. Keep the patch in the daemon ancestry after registration removal, then remove it from the daemon build. Assert monitoring/escalation while still running, eventual adoption, and notification retries without duplicate terminal effects. Retain existing historical-terminal and demoted-receipt recovery cases.
- [A4] **Executable** — Add `singleton releases only after migrated legacy hot patch settles` to `we:scripts/operations/__tests__/hot-patch-singleton.test.mjs`, using sweep-produced receipts. Assert admission stays blocked during monitoring and becomes available after legitimate terminal settlement. Validate only the two affected test files named above, passing their repository-relative paths to the queued unit-test runner.

## Non-goals

- [N1] Reopening PR #7227's operator rulings, supplying its live acceptance proof, bypassing ancestry checks, or granting new intents receipt-free terminal settlement.

## Edge cases this change must handle

1. **Untrusted text** — n/a: replay fixed local ledger fixtures; no new executable input or network endpoint.
2. **Truncated reads** — [A2] Missing completion evidence for a new intent remains incomplete; do not infer legacy status from a failed read.
3. **Shared state files** — [A2, A3] Sweep between intent and registration completion, and retry interrupted notification checkpoints.
4. **Fail closed** — [A2, A3] Unknown ancestry or adoption evidence cannot authorize terminal settlement.
5. **Identity scoping** — [A1, A4] Preserve load identity across ordinary and hot-patch fixtures and singleton receipt consumption.
6. **State over time** — [A1, A3] Replay absent, monitoring-green, pending-adoption, historical-terminal and demoted receipts across the fifteen-minute boundary.
7. **Who wrote it** — [A2] Distinguish the historical load schema from a new writer's explicit completion requirement; old-shaped receipts cannot override a new intent.
