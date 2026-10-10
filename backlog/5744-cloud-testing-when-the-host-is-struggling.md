---
bornAs: xdhugdj
kind: decision
parent: "4305"
status: open
dateOpened: "2026-10-10"
tags: []
---

# Cloud testing when the host is struggling

Held item 208 (session 2026-10-10; operator idea). When the resource service reports the host saturated (CPU/memory/swap or a long heavy queue), run gate suites on remote capacity instead. Options to evaluate: GitHub Actions larger runners / extra matrix shards on demand, a cloud VM pool, or Claude cloud sessions (VM path exists: stage-pr-view / record-verdict transports). Same verification contract (result bound to head sha). Policy: `verify.remote: off | when-saturated | always`, cost cap per day. Prepare first (decision: which remote, cost, trust/secrets). Size 8, likely an epic once decided.

## Acceptance

- [A1] **Prepared** — forks stated with a bold default: which remote, cost cap, trust and secrets, result binding to head sha.
- [A2] **Ruled** — the operator rules; build slices filed from the ruling.

## Non-goals

- [N1] Building anything before the ruling.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Remote results are untrusted until bound to the head sha by the existing verdict contract.
2. **Truncated reads** — A remote run that returns no result counts as not verified.
3. **Shared state files** — n/a until ruled.
4. **Fail closed** — No result or a timeout -> fall back to local, never green.
5. **Identity scoping** — Results scoped to repo, PR and head sha.
6. **State over time** — Results expire when the head moves.
7. **Who wrote it** — Remote verdicts carry the transport identity.
