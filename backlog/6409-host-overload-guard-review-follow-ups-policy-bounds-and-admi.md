---
bornAs: xw141la
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/lib/host-overload-settings.mjs", "we:scripts/lib/host-load.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/lane-pool.mjs", "we:scripts/__tests__/host-overload-guard.test.mjs", "we:scripts/check-standards-rules.mjs", "we:skills-src/conveyor/delivery-agent-brief.md"]
dateOpened: "2026-10-18"
tags: []
---

# Host overload guard review follow-ups: policy bounds and admission contracts

Follow-ups explicitly deferred by PR #5624 review (2026-10-18), plus its remaining prevention debt. Leave unqueued pending preparation. Duplicate advisory suggestions are grouped below. Foreground GC assertions, deterministic suite load defaults, scanner refusals and injected-environment bypass tests are covered by the repair.

## Acceptance

- [A1] Add named discriminating tests for the default host threshold and transcript/GC setting cascades.
- [A2] Instrument `boundedText` to assert bytes read and requested read ranges at and beyond the limit.
- [A3] Test mandatory host wait expiry with occupied slots and invalid-policy fallback: expiry never permits an unslotted run.
- [A4] Test deferred `we:scripts/lane-pool.mjs` GC at a process boundary: exit 75, logged overload reason, no Git work.
- [A5] Add prevention checks for configuration before healing, batch failure isolation, refusal-branch coverage and per-guarantee test mapping in the delivery card template; include positive and negative fixtures.
- [A6] Run the affected named tests through heavy admission and scoped standards. Demonstrate that reversing each guarded behavior fails its test.

## Non-goals

- [N1] Changing thresholds, weakening admission or repeating the repair's existing tests.
- [N2] Network endpoints, request bodies, CSRF and authentication: this work adds local guard verification.

## Edge cases this change must handle

1. **Untrusted text** — malformed policy values refuse; test output uses fixture data.
2. **Truncated reads** — test empty, exact-limit, oversized and multibyte input with measured read bounds.
3. **Shared state files** — occupied-slot tests retain an independent live holder; use isolated temporary state.
4. **Fail closed** — invalid policy cannot silently enable deferrable work.
5. **Identity scoping** — only explicit interactive or held contexts bypass the guard.
6. **State over time** — test host wait expiry, retained slot ownership and GC scheduling across passes.
7. **Who wrote it** — n/a: no new author-based policy or external write surface.
