---
bornAs: xcnadd5
kind: story
size: 2
status: open
scope: ["we:src/_includes/research-descriptions/probation-registry-generalisation.njk"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5953 (head bb7efb874)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5953 (reviewed head `bb7efb874ab0e04c2742faa9c04533ee18ec1e08`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:src/_includes/research-descriptions/probation-registry-generalisation.njk:34` — (failing-input, degraded) Argo Rollouts can pass missing metric data, contradicting the new prior-art claim.
   - Scenario: Configure an Argo analysis with successCondition: len(result) == 0 || result[0] &gt;= 0.95, then return an empty Prometheus result ([]). Argo's official documentation explicitly shows this producing phase: Successful, contradicting 'inconclusive, never a pass'. The research should distinguish Argo's configurable handling from this proposal's stricter insufficient-evidence policy. Evidence: [official empty-result example] (https://argo-rollouts.readthedocs.io/en/stable/features/analysis/#empty-array).
   - Claude's re-check: demonstrated break

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
