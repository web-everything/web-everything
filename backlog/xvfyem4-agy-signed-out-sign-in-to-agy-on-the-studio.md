---
kind: task
status: open
dateOpened: "2026-11-24"
tags: []
---

# agy signed out: sign in to agy on the Studio

agy is unavailable (outage 1795538211758). Sign in to agy on the Studio; two successful probes restore the auth record. Production routing does not yet consume this record automatically. This card also tracks the remaining integration and prevention requirements from PR #7440.

## Acceptance

- [A1] **Executable** — After operator sign-in, run `node scripts/operations/agy-auth-probe.mjs` twice; the second successful probe must report `agy auth: on`. This proves the record, not production routing.
- [A2] **Planned integration gate** — Before claiming agy is removed from production routing, add a test through `scripts/lib/dispatch-contracts.mjs` and `scripts/operations/review-dispatch.mjs` that writes signed-out, unreadable, missing and stale persisted records and observes no agy worker or review seat. Also cover `scripts/operations/review-extra-seats.mjs`, preparation and probation-heal selection, configured routes, and two-good-probe recovery. Production wrappers must read the persisted record by default and fail closed; grep every caller of `selectProvider`, `selectProbationWorker` and `selectReviewSeatProvider` in the gate. Probe scheduling must be exercised by the production scheduler test, not only by a manual invocation.
- [A3] **Planned job-coordination gate** — Before scheduling the probe, implement a shared agy-session lock taken by dispatch and review job launchers and the probe. Add `running dispatch job holds session lock and probe skips` and `running review job holds session lock and probe skips` fixtures with zero probe spawns and unchanged auth state. The current mkdir lock serializes probes only. No concurrent-session safety claim is supported yet.
- [A4] **Publication recovery gate** — `scripts/operations/__tests__/agy-auth-probe.test.mjs` must cover failure before starting file-item, nonzero exit, timeout and crash after card creation. Proven startup failures retry the same outage; ambiguous outcomes remain pending and fail visibly on every subsequent run. Before adding automatic retries for ambiguous outcomes, add an idempotency-key integration test through the actual card creator covering failures before and after creation and asserting exactly one durable card.
- [A5] **Classifier gate** — The same test file must directly assert `timeout classifies as signed-out` and table-drive diagnostic stderr with successful-looking stdout, malformed stdout and login prompts. Ordinary diagnostic output must never enable routing.
- [A6] **Concurrency gate** — The same test file must exercise concurrent contenders against an abandoned lock and assert neither removes it or spawns. It must also hold a live winner between spawn and completion and assert the loser skips with one spawn and one publication. Automatic stale-lock recovery is disabled; restore it only with a deterministic interleaving test proving a newly acquired lock cannot be deleted.
- [A7] **Review prevention** — Every pre-mortem mitigation in this integration must name the protected actor and its defending test, including the dispatch-job and review-job fixtures in A3. Require a production-caller test for any acceptance claiming a backend is removed from routing. A2 and A3 are completion prerequisites for claiming this integration is delivered, not evidence supplied by this probe-only patch.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This repair does not sign in, enable a scheduler, or run concurrent agy calls to infer why sessions were evicted. Those actions require the operator and A2–A3 first.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Never retain captured agy output in cards or logs; accept only a single ok reply without diagnostics.
2. **Truncated reads** — Output above 65536 bytes is unavailable and triggers the outage path; A2 covers unreadable persisted evidence.
3. **Shared state files** — Probe state uses atomic rename under the probe lock. No automatic lock stealing; inspect owner.json and remove an abandoned lock only with all probes stopped. A3 remains required for job exclusion.
4. **Fail closed** — Timeout and login prompts classify signed-out; malformed output and diagnostic stderr classify unreadable. Both keep auth off. A2 must make production callers consume that result.
5. **Identity scoping** — This action concerns the Studio agy identity; no credential material is included in the card.
6. **State over time** — Two fresh good probes recover the record. Ambiguous publication remains operator-visible until reconciliation; confirm whether a card exists before clearing cardPending. Set cardFiled=true/cardNeeded=false if found, or clear cardPending only after proving no card was created.
7. **Who wrote it** — The probe writes the auth record; a successful-looking child reply with stderr is insufficient evidence of authentication.

## Duplicate admission

New authentication outage 1795538211758; a previous sign-in action does not resolve this outage.
