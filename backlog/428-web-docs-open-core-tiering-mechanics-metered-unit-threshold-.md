---
kind: decision
size: 3
parent: "089"
blockedBy: ["554"]
status: open
dateOpened: "2026-06-12"
dateStarted: "2026-06-14"
dateParked: "2026-06-14"
preparedDate: "2026-06-12"
tags: [webdocs, monetization, open-core, business-model, plateau, decision]
relatedProject: webdocs
relatedReport: reports/2026-06-12-web-docs-tiering-mechanics.md
crossRef: { url: /backlog/091-web-docs-as-a-service-plateau/, label: "Web Docs ruling (#091)" }
---

# Web Docs open-core tiering mechanics — metered unit, threshold, billing surface

> **PARKED 2026-06-14 — too early to settle the economics; deferred behind the live-serve strategy.**
> Pricing a *hosted/metered* Web Docs offering presupposes we run a deployed SaaS — which cuts
> against the current solo-founder commercial strategy of shipping **non-deployed** solutions first
> (the open-core monetization strategy: self-run tool > single service > enterprise-custom; **defer
> live-serve**). The eventual home for a metered hosted Web Docs is **inside the larger Plateau SaaS
> product-suite shell ([#554](/backlog/554-plateau-hosted-saas-product-suite-shell-multi-product-accoun/))**
> — where several Plateau products (custom browser, etc.) are offered alongside it — not a standalone
> Web Docs subscription. Deciding the metered unit / threshold now would price a product
> we've intentionally deferred building, against zero usage data. **Unpark when** #554 is actually on
> the roadmap (i.e. the defer-live-serve guard is lifted) — the prior-art survey
> + fork framing below stay valid and ready to ratify at that point. No prep is wasted; only the
> *timing* changed. The free-tier/self-host floor invariant ([#091](/backlog/091-web-docs-as-a-service-plateau/))
> is unaffected — self-host stays the always-available, non-deployed path.

Grounded in the [Web Docs open-core tiering prior-art survey](/research/web-docs-open-core-tiering/)
([report](../reports/2026-06-12-web-docs-tiering-mechanics.md)) — how comparable docs / dev-tool /
hosting SaaS meter and tier (Chromatic, Mintlify, ReadMe, GitBook, Netlify, Vercel). [#091](/backlog/091-web-docs-as-a-service-plateau/)
ratified the open-core *principle* (the [monetization](docs/agent/platform-decisions.md#monetization) rule — open-core by usage; cancel-and-self-host always holds); this item
settles the *mechanics* it left open. **No design exists yet.** The three named axes reshape into **one
genuine fork** (the metered unit), **one settled principle** (the free/paid threshold — dissolved from a
fork by the 2026-07-01 two-confusion screen (#2091): its two invariants are already fixed rulings and the
numbers are a #427-build calibration, so nothing remained to ratify), and **one
ratify** (the billing surface — already chosen). Recommended unit: **meter the conformance-verified
regeneration — the Chromatic-snapshot analog** (price the differentiator, not seats or bytes).

## Axis-framing

The mechanics decompose into three orthogonal axes, and the prior-art survey collapses two of them. The
**metered unit** is the only real call: the market meters four incompatible ways and you pick one primary
billing primitive — per-seat (Mintlify $250/mo·5 editors; GitBook +$12/user; Netlify is *fleeing* it),
per-site (GitBook $65→$249; ReadMe $79→$349), per-value-action (Chromatic's snapshot — 5K free, metered
overage, graceful pause), or pure-infra credits (Netlify deploys 15c / bandwidth 20c/GB). Web Docs'
differentiator per [#091:206](/backlog/091-web-docs-as-a-service-plateau/#L206) is that the docs *prove
conformance*, so the value-action to meter is the **conformance-verified regeneration** — and the meter
already exists: [#089](/backlog/089-monetization-product-ideas/) idea-1's continuous-verification re-runs
the suite over time ([089:57-101](/backlog/089-monetization-product-ideas/#L57)), and the build-time
ingestion it would meter is `we:cases.js` ([we:src/_data/cases.js](../src/_data/cases.js)). The **threshold** is
downstream of the unit and genuinely a number-to-tune, pinned only by the self-host floor invariant
([#091:48-49](/backlog/091-web-docs-as-a-service-plateau/#L48), "cancel and self-host always holds"). The
**billing surface** is *not* open: [#183](/backlog/183-payments-merchant-of-record/) (resolved) ruled MoR
via **Lemon Squeezy** ([183:29-37](/backlog/183-payments-merchant-of-record/#L29)), which now supports
usage-based/metered subscriptions — so the metered hosted model composes the chosen rail rather than
reopening it.

### Recommended path at a glance

Ratify the unit (the one real call) and confirm the billing ratify; the threshold is settled below, not a
fork. The **confidence** column says where judgment is actually needed.

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| **1 · metered unit** | meter the conformance-verified regeneration (Chromatic-snapshot analog); free tier = 1 site + N verified builds/mo, graceful pause; self-host always free | per-site/project flat fee (GitBook/ReadMe) | **Medium** — genuine business judgment |
| **threshold** *(settled — not a fork)* | the two invariants below stand as fixed rulings; **numbers = #427-build calibration**, ordinary ordering | — *(dissolved 2026-07-01, two-confusion screen)* | **High** — invariants pre-fixed elsewhere |
| **billing surface** | *(ratify)* compose #183's Lemon Squeezy MoR + its metered-billing API; auth = plateau-app build detail | reopen for Stripe Billing *(rejected)* | **High** — already chosen + supports metering |

## Ratify (not a fork) — the billing surface

[#183](/backlog/183-payments-merchant-of-record/) already settled this for the whole constellation: **MoR
via Lemon Squeezy** (global VAT/tax offload is the solo-founder win). LS added usage-based/metered billing
(report-usage API, billed in arrears on renewal), so the metered hosted model fits the chosen rail with
**no reopen and no Stripe-Billing detour**. *Auth* (how a customer signs in to the hosted site) is a
plateau-app build detail, not a standards/business decision — it resolves at the [#427](/backlog/427-plateau-app-served-web-docs-site-per-customer-conformance-re/)
build. Reopening for Stripe Billing is *rejected* — it would re-litigate #183's tax-offload ruling for no
metering gain LS doesn't already provide.

## Fork 1 — the metered unit: what is the billable primitive?

**Crux.** The unit *is* the product's pricing identity (survey finding 1), and the four market units are
mutually exclusive as the *primary* primitive. Web Docs' stated edge is that the docs prove conformance
([#091:206](/backlog/091-web-docs-as-a-service-plateau/#L206)); pricing should meter the action that delivers
that edge. Chromatic is the precedent: it meters the **snapshot** — the unit of work that produces its
value — with a free allotment, metered overage, and a graceful pause at the ceiling. The Web Docs analog
is the **conformance-verified regeneration** (re-verify the suite + re-publish the site), whose machinery
already exists as #089 idea-1's continuous verification and `we:cases.js` ingestion.

- **(A — recommended) Meter the conformance-verified regeneration.** Free tier = one site + N verified
  builds/month with a **graceful pause** (last good site stays served; self-host stays unlimited and
  free). Paid = metered builds beyond the allotment, billed via Lemon Squeezy's usage API. Prices the
  differentiator, reuses the verification machinery as the meter (#089 idea-4's "one artifact, three
  outputs"), and degrades without an instant-support failure mode (aligns with #089's defer-live-serve
  caution). Cost: must define one "verified build" event crisply (per commit? per manifest+cases change?)
  so the meter is legible — a sub-decision below.
- **(B — main alternative) Per-site / per-project flat fee** (GitBook/ReadMe model). Dead simple to
  reason about and docs-native. But a flat per-site fee underprices a value that scales with re-verify
  frequency, and doesn't connect price to the conformance differentiator. Viable fallback if the metered
  model proves too complex to communicate at launch.
- **(C) Per-seat / editor** (Mintlify/GitBook). *Rejected* — docs readers are unbounded so a seat unit is
  a category error, it penalizes teams, and Netlify is actively retreating from per-seat. A small editor
  cap can ride *along* a chosen unit, but not *be* the unit.
- **(D) Pure infra (bandwidth / build-minutes / credits)** (Netlify/Vercel). *Rejected* — commoditized,
  races to the bottom, captures none of the conformance value; it's the floor competitors meter on, not a
  moat.
- **Sub-decision (hold open):** the exact "verified build" event definition (per-commit vs per
  manifest+cases change vs per scheduled re-verify). Default to the most legible to the customer — *one
  metered unit = one successful verify-and-publish of their site* — tuned at the #427 build.

*Screen: clear — fresh-context two-confusion screen (#2091), 2026-07-01: the unit choice is
customer-observable pricing identity and the branches differ on merit (what value is priced), not cost.*

## Settled (not a fork) — the free/paid threshold

*Screen: flagged(prio) → dissolved, 2026-07-01 (#2091, counter-verified). This section was authored as
"Fork 2", but its two branches shared all merit content: the recommended branch's two invariants are
already fixed rulings elsewhere, and the alternative ("pick fixed launch numbers now") was rejected purely
on timing — prioritization in fork costume per the not-a-prioritization rule. Nothing here needs a ratify
turn; what follows is the standing state.*

Once the unit is the verified build, the threshold is *how many free builds* (and what the free tier
includes). Survey finding 2: the market converges on a "one site / one individual" free tier, and
commercial-use permission is the dividing line (Netlify allows it; Vercel's Hobby bans it). Two invariants
are **already fixed rulings**, not open choices: (i) **the self-host floor is unlimited and free** — the
generator + standards stay self-hostable, so "cancel and self-host always holds"
([#091:48](/backlog/091-web-docs-as-a-service-plateau/#L48)); the free *hosted* tier need only be generous
enough to onboard a real solo/OSS project (one site, a usable monthly build allotment, commercial use
permitted). (ii) **Paid begins at ongoing production value** — continuous re-verification of a live,
hosted site past the free allotment. The *specific* free-build count and any feature gates (custom domain,
SSO, AI) are a **build-time calibration at the [#427](/backlog/427-plateau-app-served-web-docs-site-per-customer-conformance-re/)
build** against real usage — ordinary backlog ordering, the way Chromatic's 5K and Mintlify's Hobby limits
were set empirically — never a standards decision.

---

## Context

**Why this is a decision and not a build:** surfaced by slicing epic [#398](/backlog/398-build-the-web-docs-product-fui-open-primitives-plateau-app-o/).
#091 ratified the open-core principle but left the mechanics — an unresolved product/business fork, not
volume — so it couldn't be sliced as a build alongside #398's A–D. Settling it here unblocks the tiering
*build* as a plateau-app slice `blockedBy` [#427](/backlog/427-plateau-app-served-web-docs-site-per-customer-conformance-re/)
(the served free-tier product). Sibling to the #091 ruling under monetization epic #089.

**Relationship to neighbours:**
- [#091](/backlog/091-web-docs-as-a-service-plateau/) — parent ruling; ratified open-core-by-usage, named these three follow-ons.
- [#183](/backlog/183-payments-merchant-of-record/) — the billing rail this ratifies (Lemon Squeezy MoR + metered billing).
- [#427](/backlog/427-plateau-app-served-web-docs-site-per-customer-conformance-re/) — the free-tier product build; the paid-tiering build is its successor, where Fork 2's numbers are calibrated.
- [#089](/backlog/089-monetization-product-ideas/) idea-1 (continuous verification = the meter), idea-4 (Web Docs), and the solo-founder defer-live-serve lens.

**Build sequence once ratified:** the tiering build is a plateau-app slice `blockedBy` #427, itself
`blockedBy` the #424 generator + #425 primitives — so resolving this decision produces an unblocked
build, not code.

Ruled PARK in the master plan (2026-11-22); kept open with blockedBy #554 instead, so it re-enters readiness when #554 resolves.
