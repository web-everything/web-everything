---
bornAs: xx3ffrw
kind: story
size: 5
status: open
scope: ["we:scripts/operations/review-job.mjs", "we:scripts/lib/review-speculative-red-team.mjs", "we:scripts/settings/review.json", "we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs", "we:scripts/lib/__tests__/review-speculative-red-team.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red team setting redTeam.skipWhenReviewBlocked=on: no red team while the review is blocked on infra

Add redTeam.skipWhenReviewBlocked, default on, through the settings cascade with effective-source logging. Before speculative or sequential red-team launch, consult existing review infrastructure-block signals (usage/weekly limits, outage, queue cap, blocked job). Skip while a block is current; retain existing cancellation when a block becomes known after speculation starts. Skipping does not satisfy the red-team gate or clear a hold. Operator approved this behavior on 2026-10-17. The old “after #5482/#5465” note is not a dependency: those open cards scope boundary checking and drain-daemon work, respectively, not this review-job change.

## Acceptance

Run each criterion after adding its named regression cases (red before, green after). Queue helper, from the repo root:

```bash
q=we:scripts/readiness/heavy-admission.mjs
prove() { node "${q#we:}" run -- npx vitest run "${1#we:}"; }
```

- [A1] **Executable** — `prove we:scripts/lib/__tests__/review-speculative-red-team.test.mjs`: add one case per cascade layer for redTeam.skipWhenReviewBlocked: default on, platform/tool/env precedence, explicit off, invalid values falling through, and effective value/source logging.
- [A2] **Executable** — `prove we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs`: add current-block fixtures for usage/weekly limit, outage, queue cap and blocked job: with on, neither launch path starts; with off, existing scheduling applies. An unblocked review still launches normally and a different repo/PR block does not suppress it.
- [A3] **Executable** — `prove we:scripts/operations/__tests__/review-job-speculative-red-team.test.mjs`: add transitions for block expiry/recovery and a block first learned after speculation starts: suppress retries while blocked, resume only after fresh eligible state, preserve discard accounting/cancellation, and never report skipped work as accepted or remove a review hold.

## Non-goals

- [N1] No new outage/quota detector, speculative-red-team removal, automatic hold clearance, or changes to infra retry policy.

## Edge cases this change must handle

1. **Untrusted text** — Consume structured existing block signals; PR prose or model output claiming a quota block cannot suppress a seat.
2. **Truncated reads** — Unreadable block state cannot prove eligibility; defer launch with a diagnostic while preserving holds.
3. **Shared state files** — Read existing quota/job state without resetting it; avoid a second persistent block ledger.
4. **Fail closed** — A skipped or unavailable red team is not a successful red team; all acceptance/hold gates remain controlling.
5. **Identity scoping** — Use the job repo/PR/head and applicable provider scope; unrelated jobs and providers must not leak blocks.
6. **State over time** — Recheck current eligibility on retries; expired blocks can recover; blocks learned after launch retain cancellation and discard telemetry.
7. **Who wrote it** — Log effective setting/source and the existing block reason with job identity. This local scheduling guard adds no HTTP endpoint: body caps, CSRF/origin checks are n/a; it cannot reset quota/cap state.

## Grounding

- we:scripts/operations/review-job.mjs:628 loads speculative settings; :804 starts speculation before runLoop at :816.
- we:scripts/lib/review-speculative-red-team.mjs:60 resolves the existing cascade; :121 discards a speculative result when review did not accept.
- we:scripts/lib/provider-quota-hold.mjs:4 provides quota-hold state; we:scripts/conveyor/reconcile-core.mjs:963 consumes blocked-on-infra completion state.
- we:backlog/5482-constellation-boundary-guard-count-cross-destination-imports.md:9 and we:backlog/5465-prevention-use-r-marked-length-0-here-also-add-a-small-test.md:7 show unrelated scopes.
