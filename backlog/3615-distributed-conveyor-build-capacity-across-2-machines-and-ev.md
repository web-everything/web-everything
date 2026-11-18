---
bornAs: xgcxmha
kind: epic
status: open
scope: ["we:scripts/lane-pool.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/file-locks.mjs"]
relatedTo: ["3611", "2275", "1936", "1391", "1753"]
dateOpened: "2026-09-08"
tags: [conveyor, lane-pool, infra, multi-host, capacity]
---

# Distributed conveyor build capacity across 2+ machines (and eventually VMs)

The operator is adding a second dedicated build machine (a headless build host, for parallel lane execution -- npm install/vitest/vite across lane worktrees) alongside the laptop that runs the conveyor today, and eventually wants cloud/VM burst capacity too. The conveyor and lane-pool currently assume a single local host: we:scripts/lane-pool.mjs provisions and refreshes lanes only under the workspace root on the machine the conveyor process itself runs on, and we:scripts/conveyor/tick-core.mjs dispatches every lane locally with no notion of "which host". Before/as the second machine comes online, this needs a real notion of multiple build hosts the conveyor can dispatch lanes to -- not just the single machine it runs on today -- with the same abstraction (a registered remote build host) covering both "second physical machine" and "VM/cloud node" so neither needs a redesign later.

Scope: (1) a host registry/discovery mechanism -- which build hosts are online, their current lane capacity/load, so dispatch can pick a host with headroom, not just a lane slot; (2) extend we:scripts/lane-pool.mjs's allocator so a lane's checkout can live on a remote host, not only under the local workspace root; (3) extend we:scripts/conveyor/tick-core.mjs's dispatch to route a lane's build/verify commands to its assigned host; (4) the eventual VM/cloud-hosted build node must be the SAME abstraction as a second physical machine (a registered remote build host), not a parallel mechanism bolted on later.

Explicitly distinct from a separate item filed the same day for a skill/command that routes an interactive session's file/prepare/build REQUESTS to the conveyor session via cross-session messaging (session-to-session request routing) -- that is orthogonal: this item is about distributing actual BUILD EXECUTION across physical/virtual hosts, not about how a human session asks the conveyor to do something.

Investigated four candidates before filing as a sibling rather than a slice of any of them: we:backlog/3611-hardware-usage-aware-heavy-command-capacity-control-a-staged.md (adaptive concurrency CAP within one host's own measured CPU/memory headroom -- capacity-control, not distribution across hosts); we:backlog/3461-build-the-heavy-command-admission-queue-a-capacity-semaphore.md (resolved -- a single-host admission semaphore, we:scripts/readiness/heavy-admission.mjs, host-wide lock root under one workspace, no host concept at all); we:backlog/2275-generalize-the-lane-pool-into-a-use-agnostic-leased-checkout.md (resolved -- generalized the lane as a leased checkout, but its own "Out of scope (follow-on -- file separately if pursued)" section explicitly named "Remote / CI executor" as deferred future work, which this item is); we:backlog/1936-cross-session-lock-primitive-and-stale-lock-reclaim-policy-f.md (resolved decision -- its own "Topology that constrains this decision" section states "single machine, single authority" and rules out consensus services as overkill "for one machine"; the atomic-lockfile-under-the-local-checkout primitive it ratified will need real extension once locks must be visible across hosts). None of the four substantially cover multi-host distribution, so this is a new epic, related to all four as precedent/adjacent concerns rather than blocked by any of them, plus we:backlog/1391-dev-browser-shell-build-chromium-shell-embedding-plateau-app.md and we:backlog/1753-dev-browser-shell-scaffold-stock-chromium-desktop-shell-we-c.md (the dev-browser build work this traces back to, per the requester's own framing).

**Note on a fifth relation not yet linkable:** the requester also asked this item to link, as `related` (not
`blockedBy`), to a same-day sibling item for a skill/command that routes an interactive session's
file/prepare/build REQUESTS to the conveyor session via cross-session messaging. That item was not found on
`main` as of this filing (2026-09-08) — it was likely still in flight in a concurrent lane/PR at filing time.
Add its number to `relatedTo` above once it lands.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
