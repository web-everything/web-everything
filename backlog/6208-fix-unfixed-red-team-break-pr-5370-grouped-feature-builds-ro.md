---
bornAs: xhosxil
kind: story
size: 3
status: open
scope: ["we:scripts/operations/dispatch-providers/probation-worker.mjs", "we:scripts/lib/dispatch-routing-policy.json"]
dateOpened: "2026-10-17"
tags: []
---

# Fix unfixed red-team break (PR 5370): grouped feature builds routed into a probation provider that refuses groups

Operator 2026-10-17: Ok. Real confirmed red-team break (broken, failing-input) never fixed on PR 5370, which merged 2026-10-15. we:scripts/operations/dispatch-providers/probation-worker.mjs:47 - Grouped feature builds are routed into a provider that refuses groups. Scenario: route {kind:'build', size:3, scopePaths:['we:scripts/example.mjs']} and dispatch it with groupMembers:['9002'], probationLaunch:'on' and all executables available; the new default feature route selects probation, but routeDispatchProvider throws 'grouped probation requests require prepare-item' before invoking any provider, including the mechanical build provider; zero provider calls. Grouped feature builds should keep the group-capable delivery path or get a group-capable probation implementation. Confirmed by the Claude re-check. Source: red-team-analysis quality sample (20 breaks: 3 real never fixed).

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
