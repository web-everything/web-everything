---
bornAs: xi0psez
kind: story
size: 5
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-overlays.mjs", "we:scripts/lib/marker-authorship.mjs", "we:scripts/operations/extend-rounds-io.mjs", "we:scripts/operations/__tests__/extend-rounds-io.test.mjs", "we:scripts/__tests__/daemon-overlay.test.mjs", "we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention: authenticate conflict overrides through a trusted credential producer

PR #5809 inherits the extend-rounds credential check: caller-controlled WE_OPERATOR_LOGINS and gh resolution through PATH are not a trusted operator boundary. Introduce a trusted-producer credential check shared by conflict override and extend-rounds. Pin operator identities in a repo-pinned or protected file and invoke a trusted credential reader by absolute path with sanitized environment; account for an agent sharing an operator-authenticated session. Operator-instruction text is audit context, not authorization evidence. Test an attacker-set bot allowlist, fake gh first on PATH, unreadable credentials, and both add and load registration paths; all must refuse without mutating registrations. Preserve verified operator overrides and record verified identity.

## Acceptance

- [A1] **Executable** — Add named attacker-environment cases to we:scripts/__tests__/daemon-overlay.test.mjs and we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs. Bot-controlled WE_OPERATOR_LOGINS plus a fake gh first on PATH must not authorize an override or mutate registrations; verified operator credentials must still succeed.
- [A2] Use a repo-pinned or protected operator allowlist and a trusted absolute credential-reader path with a sanitized environment; document the producer's boundary against an agent sharing the operator's authenticated session.
- [A3] Share the trusted producer with extend-rounds and record verified identity separately from caller-supplied instruction text. Unreadable or unverifiable identity refuses.

### Planned behavioral mappings

These cases are planned, not implemented or claimed passing. A1 and A2 cases must run in **both** `we:scripts/__tests__/daemon-overlay.test.mjs` and `we:scripts/lib/__tests__/daemon-load-overlay-guard.test.mjs`.

| Acceptance | Named case | Fixture and observable assertion |
| --- | --- | --- |
| A1 | `refuses attacker PATH and operator allowlist overrides` | Put fake gh first on PATH and set WE_OPERATOR_LOGINS to the attacker login, independently and together; assert refusal and byte-identical registrations. |
| A1, A2 | `accepts only the protected operator identity from the trusted reader` | Supply protected allowlist and trusted-reader fixtures plus competing caller config/environment; assert the absolute reader and sanitized environment are used, caller values cannot authorize, and verified operator registration succeeds. |
| A2 | `refuses shared operator sessions without operation-bound approval` | Give the agent an operator-authenticated session but no producer approval bound to this operation; assert refusal. A matching approval succeeds; replayed, expired or differently bound approval refuses. |
| A3 | `records verified identity separately from untrusted instruction text` | In both add/load files above, supply a valid producer principal and a quote claiming another identity; assert stored identity equals the producer and the quote remains audit context only. |
| A3 | `refuses unreadable or unverifiable producer identity` | In both add/load files above, inject timeout, malformed, partial and unverifiable producer responses; assert no registration mutation. |
| A3 | `extend-rounds shares the conflict-override trusted producer` | In `we:scripts/operations/__tests__/extend-rounds-io.test.mjs`, drive extend-rounds with the same trusted/attacker/error fixtures; assert identical authorization results and verified-identity provenance, with no unauthorized write. |

Re-raised by PR #5809's 2026-10-23 security review: the present gate can be bypassed with **both a fake gh on PATH and a caller-set allowlist**, even without an operator-authenticated session. This card tracks that accepted residual explicitly; the current gate must not be described as a trusted producer.

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
