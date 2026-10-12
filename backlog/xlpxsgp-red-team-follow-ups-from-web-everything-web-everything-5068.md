---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/review-dispatch.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5068 (head c78fa0daa)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5068 (reviewed head `c78fa0daa84b714cc44274f4c4afd58710e8b858`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/review-dispatch.mjs:259` — (failing-input, degraded) Codex review seats silently discard explicit lens effort settings when provider routing is inherited.
   - Scenario: Set operations['review-seat:standards-conformance'] to {"inherit":true,"effort":{"codex":"ultra"}} in the routing policy, then call reviewSeatRoutes with available:['codex']. The policy validates and operationEffort returns 'ultra', but the changed routing function returns 'medium' for that seat. Because resolveOperationRoute returns null for inherited provider selection, the new Codex branch bypasses resolveOperationEffort and discards the explicit lens setting. It should preserve the configured 'ultra' effort while inheriting provider selection. Reproduced by evaluating the unchanged routing
   - Claude's re-check: In the diff, a codex pick takes 'effort' from 'resolveCodexTaskRoute({kind:'review', effort: configured?.effort})', and the final effort is 'configured?.effort ?? effort'. 'resolveOperationEffort('review-seat','codex',s.key,policy)' is now only called for non-codex providers. If 'configured' is null (inherited provider selection) or carries no effort, a per-lens policy effort such as codex:'ultra' is never consulted and the seat gets the route default 'medium'. The old code applied that lens effort. That 'resolveOperationRoute' returns null for inherit is not visible in the diff, but the bypas

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
