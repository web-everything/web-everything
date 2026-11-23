---
kind: epic
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 3 (evergreen self-updating app needs hosted delivery)."
dateParked: "2026-11-22"
dateOpened: "2026-06-06"
tags: [evergreen, vision, north-star, auto-update, module-as-a-service, requirement-as-code, ai, app-shell, platform, conformance]
relatedReport: reports/2026-06-06-front-end-platform-book.md
crossRef: { url: /protocols/, label: Conformance protocols }
---

# The evergreen app — the self-updating, always-current app as the constellation's north star

The **evergreen app** is an application that keeps *itself* current — staying on the latest libraries, platform standards, and practices with little or no manual migration, so it never rots. It is the unifying "Holy Grail" of the archived design essay (`we:reports/2026-06-06-front-end-platform-book.md`, section *"The evergreen app"*) and the implicit target most of the existing monetization/tooling cluster (#086–#096, [intents-ux-only](docs/agent/platform-decisions.md#intents-ux-only)) already points at. This item names it as an explicit **north-star vision** so the scattered mechanisms (versioning, distribution, upgraders, verification, the relationship graph) are understood as *parts of one machine*, not unrelated products.

## The picture (from the essay, mapped to today's constellation)

An evergreen app holds together because thin app-specific code sits on **mature, low-level Web APIs + a public/private Platform API**, delivered as **Module-as-a-Service** loaded just-in-time, and every moving layer can update under it without breaking the app:

| Essay ingredient | Where it lives now |
|---|---|
| Requirement-as-code the Platform AI understands (BDD-like, editor flags contradictions/gaps) | **new — #100** |
| Common code (incl. libraries) served as MaaS, version-ranged, loaded just-before-need | #081 / #087 / #088 |
| Auto-update to latest (even major) with risk analysis, buffer, phased rollout, reversion, gates | **new — #101** |
| Migration scripts shipped with breaking changes + per-module changelog manifest | #094 + **new — #102** |
| Incremental/delta updates via service worker | **new — #103** |
| AI auto-tests a growing share of requirements; learns the rest | #095 + #100 |
| Apps that don't update keep running on an older app shell, flagged on the dashboard | **new — #104** ([constellation-placement](docs/agent/platform-decisions.md#constellation-placement)) + #092 |
| Always-on monitoring, revert-without-deploy, conformance never drifts | #089 idea 1 / #093 ([monetization](docs/agent/platform-decisions.md#monetization)) |

## Why it's worth naming as one thing

Each part already has (or is getting) its own item, but the *value* is the loop: requirements → verified code → versioned MaaS → safe auto-update → monitored in prod → still conformant. The essay's insight is that this loop is only achievable on a **standards-based, introspectable platform** — exactly what the constellation is. The evergreen app is the end state that justifies the protocols/registries existing at all. Keep this item as the durable statement of that target; the mechanism items are its children.

## Design notes (recommended)

- Is "evergreen" a **maturity rating** an app earns (a dashboard score: how much updates without intervention), a **protocol/conformance tier**, or just a vision label? Recommendation: start as a vision + a dashboard score (#092/#104), graduate to a tier only if it proves measurable.
- The hardest unsolved piece is **requirement-as-code → automatic verification** (#100/#095); everything else (versioning, delivery, upgraders) is comparatively tractable. Sequence the vision around closing that gap.
- **Un-itemized essay ideas** (from `we:reports/2026-06-06-front-end-platform-book.md`, not yet carved into items): form controls, notifications, container-query responsive, logging/tracking, nomenclature/import standards. Mine into backlog items as the vision is worked. *(Breadcrumb right-homed here from a personal-memory reference, 2026-06-27, #1881.)*

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 3 (evergreen self-updating app needs hosted delivery).
