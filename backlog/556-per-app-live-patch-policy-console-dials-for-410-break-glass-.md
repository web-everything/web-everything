---
kind: story
size: 5
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: dev-browser live patch (#410) ships and Platform > Governance exists."
dateParked: "2026-11-22"
blockedBy: ["410", "554"]
dateOpened: "2026-06-14"
tags: [dev-browser, live-patch, deployed-app, saas, policy, governance, hosted]
---

# Per-app live-patch policy console — dials for #410 (break-glass, TTL, two-party, lifetime)

#410 (the [monetization](docs/agent/platform-decisions.md#monetization) rule) makes deployed live-patch authorization rigor and patch lifetime per-app policy dials (break-glass elevation, max TTL, two-party-approval on/off, ephemeral-vs-session lifetime). Those dials need a management home. This story builds the per-app policy console in the hosted SaaS where an org sets who may break-glass, the hard TTL ceiling, whether two-party approval is required, and the default patch lifetime per app — the admin surface for the configurable axes #410 ratified. Blocked on #410 (defines the dials) and #554 (the SaaS shell).

## Dials this console manages (all defined by #410)

- **Authorization rigor** (Fork 2) — who may authorize a deployed live-patch; break-glass JIT on/off; flip
  the **two-party-approval** dial per app for higher-rigor orgs.
- **Patch lifetime** (Fork 3) — default **session-scoped** vs. the stricter **ephemeral-per-action**
  opt-in; the **hard TTL ceiling** a forgotten session can't exceed.
- **Sub-decision scope** (Fork 2 sub-decision) — whether a policy is set per-app, per-user-profile, or
  per-org; #410's default is **per-app caps what a profile may request**.

Pure configuration surface for already-ratified axes — no new policy semantics, just their management home.
Sibling hosted work: the collaboration epic (#555) and the audit/compliance dashboard (#557).

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: dev-browser live patch (#410) ships and Platform > Governance exists.
