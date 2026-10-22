---
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/marker-authorship.mjs", "we:scripts/operations/extend-rounds-io.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: authenticate conflict overrides through a trusted credential producer

PR #5809 inherits the extend-rounds credential check: caller-controlled WE_OPERATOR_LOGINS and gh resolution through PATH are not a trusted operator boundary. Introduce a trusted-producer credential check shared by conflict override and extend-rounds. Pin operator identities in a repo-pinned or protected file and invoke a trusted credential reader by absolute path with sanitized environment; account for an agent sharing an operator-authenticated session. Operator-instruction text is audit context, not authorization evidence. Test an attacker-set bot allowlist, fake gh first on PATH, unreadable credentials, and both add and load registration paths; all must refuse without mutating registrations. Preserve verified operator overrides and record verified identity.

## Acceptance

- [A1] **Executable** — Add named attacker-environment cases to we:scripts/__tests__/daemon-overlay.test.mjs and we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs. Bot-controlled WE_OPERATOR_LOGINS plus a fake gh first on PATH must not authorize an override or mutate registrations; verified operator credentials must still succeed.
- [A2] Use a repo-pinned or protected operator allowlist and a trusted absolute credential-reader path with a sanitized environment; document the producer's boundary against an agent sharing the operator's authenticated session.
- [A3] Share the trusted producer with extend-rounds and record verified identity separately from caller-supplied instruction text. Unreadable or unverifiable identity refuses.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] No relaxation of conflict checking and no claim that instruction text proves operator consent. Do not retrofit unrelated authorization paths without a shared trust-boundary review.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Ignore attacker allowlist/PATH overrides, typed actor names, shell metacharacters and instruction text as authority.
2. **Truncated reads** — Partial, malformed or timed-out credential responses refuse without registration.
3. **Shared state files** — Keep admission under the existing add-guard lock and record verified provenance with the registration.
4. **Fail closed** — Missing producer, changed protected configuration or unverified principal refuses both add and load paths.
5. **Identity scoping** — Bind the result to the actual credential and operation; bot credentials cannot self-appoint as operator.
6. **State over time** — Cover credential rotation, allowlist updates, stale authorization and replayed producer responses.
7. **Who wrote it** — Only the trusted producer supplies identity/authorization evidence; caller-controlled quote and environment are audit context.
