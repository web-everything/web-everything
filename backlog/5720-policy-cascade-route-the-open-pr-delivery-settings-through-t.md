---
bornAs: xbggr1p
kind: story
size: 3
status: open
priority: high
scope: ["we:scripts/lib/policy-cascade.mjs", "we:scripts/lib/__tests__/policy-cascade.test.mjs", "we:scripts/lib/merge-queue-hook.mjs", "we:scripts/lib/review-settings.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Policy cascade: route the open-PR delivery settings through the shared policy-cascade resolver

Settings added 2026-10-09/10 in open PRs (and two main settings whose readers those PRs hold) skip the platform-preference layer: they label we:scripts/settings/*.json as the platform preference, but that file is the tool override. Each must read through cascadePolicy() in we:scripts/lib/policy-cascade.mjs and get a row in its table-driven test.

Operator go 2026-10-10 (agent-memory 151, card x5wnfcg): standard default → Platform Forever preference (team level) → tool/repo override (Longshore settings file) → env, with the effective value's source logged. The shared resolver landed in the settings-cascade-audit PR; the items below were left out because open PRs own the files (do NOT edit those PRs from here — each change lands with or after its PR).

## The exact change, per setting

The same change for every row: in the reader, pass the tool block through
`cascadePolicy('<policy key>', toolBlock, { env, standard: <built-in defaults>, envValues: { <key>: <parsed env or undefined> } }).layered`
(from we:scripts/lib/policy-cascade.mjs) and use the result as the tool block. Relabel the settings file's
`$comment` from "Platform preference" to "Tool override (platform preference: key `<policy key>` in
we:scripts/lib/delivery-platform-preferences.json)". Add one row to `ROWS` in
we:scripts/lib/__tests__/policy-cascade.test.mjs.

| PR | Setting (policy key) | Reader to change |
|---|---|---|
| #4763 | `review.parallelSeats`, `review.seatsByTouchSet` (`review`) | we:scripts/lib/review-seat-settings.mjs |
| #4762 | `redTeam.confirmedBreaks` (`redTeam`) | we:scripts/lib/red-team-gate.mjs (its "platform file" is the tool layer) |
| #4761 | `drainFollowupJob` (`drainFollowupJob`, scalar) | we:scripts/lib/drain-followup-job.mjs |
| #4759 | `takeoverReviewAttempts`; and main's `roundBudget`, `scopedRereview`, `referralDefault` (`review`) | we:scripts/lib/review-settings.mjs `loadReviewSettingsFile` (held by #4759, so main's three keys are not migrated yet) |
| #4757 / #4756 | `fix.roundCapAction`, `fix.resumeAcrossRounds`, `fix.strongerModelFromRound` (`fix`) | we:scripts/conveyor/fix-takeover.mjs, we:scripts/conveyor/fix-resume.mjs |
| #4722 / #4750 | resource policy thresholds (`resourceAdmission`) | we:scripts/lib/resource-policy.mjs: drop its own platform store (env `WE_PLATFORM_PREFERENCES` / a file under the Claude home) and read `platformPreference('resourceAdmission')` — ONE platform store |
| #4689 | `mergeQueue` affected re-test mode; and main's `mergeQueue.*`, `mergeFreshness.*` (`mergeQueue`, `mergeFreshness`) | we:scripts/lib/merge-queue-hook.mjs `loadMergeQueueSettings` (held by #4689, so main's blocks are not migrated yet) |
| #4631 | `acceptCarryForward` (`acceptCarryForward`) | we:scripts/lib/accept-carry-forward.mjs |
| #4708 / #4715 / #4717 | `mergeDelivery` | we:scripts/lib/merge-delivery-policy.mjs: keep its validators, but resolve through `resolveCascade` and log through `logCascadeSources` instead of its own per-key loop |

Not listed (their workers are building them on the cascade already): builder `maxLaunchesPerTick`, `speculativeRedTeam`, `fix.pushBeforeGate`.

## Acceptance

- [A1] **Executable** — the table-driven test we:scripts/lib/__tests__/policy-cascade.test.mjs (via `npm run test:unit`) with one `ROWS` entry per setting above: each fails before (the platform value is ignored) and passes after.
- [A2] A daemon reading each migrated setting logs `policy-cascade · <policy>: …` with the layer of each value.

## Non-goals

- [N1] Changing any current value: today's file values stay the tool override; no platform preference is set by this card.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: settings files are repo-owned config.
2. **Truncated reads** — a torn platform file is skipped and named (`readPlatformPreferences` errors); lower layers answer.
3. **Shared state files** — the platform file is read-only to readers; per-key merge, no writes.
4. **Fail closed** — an invalid platform or tool value never overrides a lower layer.
5. **Identity scoping** — n/a: one repo, one team preference.
6. **State over time** — daemons re-log a policy's sources when the effective set changes.
7. **Who wrote it** — n/a: config edits land only through PRs.
