---
bornAs: x334ind
kind: story
size: 8
parent: "6188"
status: open

dateOpened: "2026-10-17"
tags: []
scope: ["we:scripts/conveyor/health-file-request.mjs", "we:scripts/conveyor/health-watch-core.mjs", "we:scripts/conveyor/__tests__/health-file-request.test.mjs", "we:scripts/operations/health-file-request-land.mjs", "we:scripts/operations/__tests__/health-file-request-land.test.mjs", "we:scripts/lib/delivery-priority.mjs"]
---

# Incident triggers, ledger and deterministic triage with filing (smallest useful, no LLM)

Add a separate daemon incident pass over health-watch episodes, initially shadow-only. Settling is blocking 10 minutes, degraded 30 minutes, inefficiency 60 minutes; flaps do not retrigger. A new pass follows close/reopen plus a six-hour cooldown, or recurrence crossing 3 or 10. Impact is blocked items × minutes × episodes in seven days. Reuse the existing filing ledger/landing machinery instead of creating a competing filer. Operator instruction (2026-10-17): auto-queue a P0 fix only for a fixed-rule cause match; model-proposed fixes require operator approval. Impact bands and the P0 relationship remain undecided.

## Acceptance

Run each criterion after adding its named regression cases (red before, green after). Queue helper, from the repo root:

```bash
q=we:scripts/readiness/heavy-admission.mjs
prove() { node "${q#we:}" run -- npx vitest run "${1#we:}"; }
```

- [A1] **Executable** — `prove we:scripts/conveyor/__tests__/health-file-request.test.mjs`: add fake-clock incident cases immediately below/at each settle boundary, flap suppression, close/reopen cooldown, recurrence crossings exactly once, and seven-day expiry. Pin urgent/later/escalate boundaries only after the ruling below.
- [A2] **Executable** — `prove we:scripts/conveyor/__tests__/health-file-request.test.mjs`: add restart/concurrency cases on a real temporary ledger: one row per scoped incident trigger, corrupt ledger refuses, shadow records the would-file text and setting sources without filing or auto-queuing; existing open-card/PR matches suppress a second filing.
- [A3] **Executable** — `prove we:scripts/operations/__tests__/health-file-request-land.test.mjs`: extend the existing temporary-directory tests with a real throwaway-repo exercise with a seeded main-ci-red episode: shadow makes zero filing calls, enforce produces exactly one card across retries; fixed-rule provenance is required for auto-queue and an unapproved model suggestion never queues.

## Non-goals

- [N1] No LLM triage, new health detectors, execution inside the health-watch tick, or silent override of P0 eligibility.

## Edge cases this change must handle

1. **Untrusted text** — Scrub episode digests; a structurally valid model suggestion cannot claim fixed-rule authority.
2. **Truncated reads** — Unreadable/truncated episode state, ledger or dedupe lookup prevents filing; never interpret it as no prior incident.
3. **Shared state files** — Reuse atomic ledger writes and generation locks; coordinate claims with the existing landing worker.
4. **Fail closed** — Unknown mode or unavailable dedupe/priority facts cannot authorize an enforce write or auto-queue.
5. **Identity scoping** — Scope incident identity to repo, smell, subject and trigger generation; same subjects in different repositories remain distinct.
6. **State over time** — Persist trigger crossings across restarts; flaps do not reset settling/cooldown; partial landing retries retain the same claim identity.
7. **Who wrote it** — Record episode, matched rule, effective setting sources and filing attempt. Local daemon has no HTTP body/origin/CSRF surface; retain filing cap and lane-starvation guard, and do not expose a trigger-reset bypass.

## Grounding

- we:scripts/conveyor/health-file-request.mjs:133 already plans filings with dedupe, daily cap and starvation gates.
- we:scripts/conveyor/health-file-request.mjs:203 rejects corrupt ledgers; :265 locks updates; :342 checks landing attempt identity.
- we:scripts/lib/delivery-priority.mjs:106 derives P0 for an owned main-red fix or down-service repair, not an impact score.

## Open questions

Readiness blocked: what exact impact thresholds select urgent/later/escalate, and can score alone authorize P0 or must the existing eligibility rule control? What event counts toward recurrence, and do crossings at 3/10 bypass settling as well as cooldown? Specify how the new trigger generation coexists with existing permanent smell/subject dedupe. These answers are needed before assigning a new daemon job or final scope.
