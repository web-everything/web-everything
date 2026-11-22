---
kind: story
size: 8
parent: "554"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: #554 unparks (hosted runner dashboard)."
dateParked: "2026-11-22"
humanGate: { kind: setup, what: "The operated/hosted tier (plateau-app Phase 2/3) is gated on the #554 SaaS-phase go/no-go — a founder decision to enter the SaaS phase and provision hosting/accounts. Its slice deps (#558/#559/#560) are resolved; what remains is out-of-phase behind the defer-live-serve roadmap, not agent-buildable until the operated tier is on the roadmap." }
dateOpened: "2026-06-14"
tags: [auto-update, runner, plateau-app, hosted, dashboard, live-serve, parked, out-of-phase]
---

# Auto-update operated runner surface + dashboard (plateau-app, hosted tier)

Slice 4 of the #497 ruling (Fork 1 → A — the [constellation-placement](docs/agent/platform-decisions.md#constellation-placement) rule) — the open-core hosted/operated tier: a plateau-app surface + dashboard over the auto-update runner (status of in-flight updates, gate verdicts, rollout/rollback state, failed-update triage). OUT-OF-PHASE / PARKED at creation: this is plateau-app Phase 2/3 (backend-backed, operated), which parks under #554 behind the defer-live-serve strategy — sliced now only so the hosted tier has a citable home, not to build before live-serve is on the roadmap. Blocked by slices 1-3 (#558/#559/#560) and, by phase, the live-serve roadmap. Per #497 Ruling and slice plan; plateau:plateau-app/CLAUDE.md 'THE PHASE RULE'.

> **PARKED at creation 2026-06-14 — out of phase, not active work.** This is the backend-backed operated
> tier (plateau-app Phase 2/3). It stays parked behind the defer-live-serve strategy and under #554.
> **Unpark when** slices 1–3 are built *and* running a deployed Plateau SaaS is on the roadmap.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: #554 unparks (hosted runner dashboard).
