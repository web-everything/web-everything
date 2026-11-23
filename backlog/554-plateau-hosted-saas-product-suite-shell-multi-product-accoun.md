---
kind: epic
parent: "089"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 1 earns revenue on flat cost and live-serve is on the roadmap (#089/#097); then account, sign-in and cross-product billing."
dateParked: "2026-11-22"
humanGate: { kind: setup, short: "Founder go/no-go to enter the SaaS phase + provision hosting, accounts & billing.", what: "Standing up the Plateau hosted-SaaS suite is a founder go/no-go to enter the SaaS phase and provision hosting/accounts/billing — a human business decision, not agent-mechanical work." }
dateOpened: "2026-06-14"
tags: [monetization, plateau, saas, hosted, product-suite, live-serve, deferred]
---

# Plateau hosted SaaS product-suite shell — multi-product account + billing surface

The deferred home for offering multiple Plateau products (custom browser, Web Docs, platform-manager) together as one hosted SaaS — a unified account, sign-in, and metered/subscription billing surface across the suite, rather than per-product standalone subscriptions. Parked by intent behind the solo-founder defer-live-serve strategy (we ship non-deployed solutions first). This epic exists so deferred hosted-economics items (#428 Web Docs tiering, future hosted slices) point at a concrete number instead of a phrase. Unpark when live-serve is on the roadmap; then settle the suite's account model, bundling, and cross-product billing — at which point the parked per-product economics items unpark under it.

> **PARKED at creation 2026-06-14 — placeholder home, not active work.** This epic is intentionally a
> *concept anchor*, not a build queue: it gives the recurring "larger Plateau SaaS app" idea a citable
> `#NNN` so deferred hosted items reference a number instead of a phrase. It stays parked behind the
> defer-live-serve guard. **Unpark when** running a deployed
> Plateau SaaS is actually on the roadmap.

## Why this exists separately from the per-product epics

The constellation deliberately has **no single "home" for managed offerings** — per the [#091](/backlog/091-web-docs-as-a-service-plateau/)
/ #092 rulings (the [monetization](docs/agent/platform-decisions.md#monetization) rule) each managed offering decomposes across the constellation (standard→WE, primitives→FUI,
served product→plateau-app). That layering answers *"how is one product hosted"*, not *"how are several
products sold together"*. This epic is the latter: the **suite-level shell** — one account, one sign-in,
one cross-product billing surface — that the individual product epics would plug into once live-serve is
pursued. It is **not** a fourth copy of any product; it's the wrapper they'd share.

## What this epic will eventually settle (deferred — not a live fork)

These are *not* open design forks to carve now — they are the questions this parked epic will frame once
it unparks. Listed only to scope what "settle the suite" means:

- **Account/identity model** for the suite (one Plateau account spanning products vs per-product auth).
- **Bundling & cross-product billing** — single subscription with product entitlements vs separate
  metered lines composed on one invoice (the Lemon Squeezy MoR rail from [#183](/backlog/183-payments-merchant-of-record/) carries forward).
- **Which products ship in the suite first** and in what order.

## Relationship to neighbours

- [#089](/backlog/089-monetization-product-ideas/) — parent monetization epic (strategy umbrella).
- [#428](/backlog/428-web-docs-open-core-tiering-mechanics-metered-unit-threshold-/) — parked; its unpark trigger *is* this epic going live. The Web Docs metered economics settle **inside** this suite, not as a standalone Web Docs subscription.
- [#398](/backlog/398-build-the-web-docs-product-fui-open-primitives-plateau-app-o/) — the Web Docs product build; a candidate first tenant of the suite.
- [#402](/backlog/402-plateau-platform-manager-product-graph-aggregation-impact-an/) — the platform-manager product; another candidate tenant.
- [#183](/backlog/183-payments-merchant-of-record/) — the billing rail (Lemon Squeezy MoR) the suite's billing surface would compose.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 1 earns revenue on flat cost and live-serve is on the roadmap (#089/#097); then account, sign-in and cross-product billing.
