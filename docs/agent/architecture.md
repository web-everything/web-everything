# Architecture — Plugs, Blocks, Injectors, Registries

> Tier-1 reference. Read when changing core primitives, wiring, or parsers.

## Architectural Principles
- **Protocol over Implementation**: define the interface (TS Interface), not the library.
- **Intents are UX protocols**: describe the desired interaction (the "what/why") at project level. Documentation of app behavior, *not* a component library. Include only: dimensions, states, events, per-level contracts. Exclude: conformance tiers, DI concerns, type shapes, registries — move those to the block.
- **Behaviors are implementations**: custom attributes (`layout:grid`) attach functionality. Not Intents.
- **Design System superset**: Intents must be abstract enough to configure any major design system (Material, Carbon, Fluent…). A design system is just a config of Web Intents + CSS.
- **Native alignment**: align with existing Web APIs (`Storage`, `EventTarget`, `CustomElementRegistry`) over framework patterns.
- **Dependency injection**: use Web Injectors for all composition.
- **Zero-build first**: works in the browser (ES Modules); build-time optimization is additive.

## Plugs vs Blocks

**Ownership (ruling [#606](../../backlog/606-where-does-the-plugs-platform-layer-runtime-live-web-everyth.md)):** the plugs/blocks **runtime is implementation owned by Frontier UI** (`@frontierui/plugs`, `@frontierui/blocks`). **WE owns the *contracts*** — the plug list (`src/_data/plugs.json`), block protocols, intents, and protocols — and consumes the FUI runtime as a client in its demos. The `plugs/` and `blocks/` trees in this repo are **vendored copies pending the [#170](../../backlog/170-plugs-duplicated-across-webeverything-frontierui.md) re-point** to the canonical `@frontierui/*` packages.

| Layer | Purpose | Canonical home | Window global | Examples |
|-------|---------|----------------|---------------|----------|
| **plugs** | Core primitives, patches, registries (implementation) | `@frontierui/plugs` (vendored at `plugs/` pending #170) | Yes (via bootstrap) | CustomStore, CustomAttribute, InjectorRoot |
| **blocks** | Reusable implementations | `@frontierui/blocks` (vendored at `blocks/` pending #170) | No (import directly) | SimpleStore, OnEventAttribute, CallParser |
| **plug / block contracts** | The standard's plug list + block protocols (what WE owns) | `src/_data/plugs.json`, `src/_data/blocks.json` + `block-descriptions/*` | No (no runnable code) | CustomPositioner, CustomEditorEngine |
| **protocols** | Conformance contracts owned by a Project (interfaces, registry shapes, observable states/events) | `src/_data/protocols.json` + body in `project-*.njk` | No (no runnable code) | Validation, Error Recovery, Anchor Positioning |
| **design systems** | Named theme+intents bundles ([#747](../../backlog/747-design-system-equals-theme-plus-intents-bundle-manifest-catalog.md) Fork-3-A) — a thin rendering index pointing at manifests | `src/_data/designSystems.json` (index) + `design-systems/*.designsystem.json` (manifests) + DTCG `*.tokens.json` | No (config, consumed by the #749 switcher) | Material-like, Acme Brand |

- **Plugged mode**: bootstrap applies patches, exposes globals on `window`.
- **Unplugged mode**: direct imports, no patches, tree-shakeable. (The unplugged, non-invasive library is the real product surface — #606.)

**Authoring a design system** ([#747](../../backlog/747-design-system-equals-theme-plus-intents-bundle-manifest-catalog.md) Fork-3-A, built in [#871](../../backlog/871-build-the-design-system-bundle-infrastructure-designsystems-.md)) — two layers, surfaced at `/design-systems/`:
1. Drop a manifest at `design-systems/<id>.designsystem.json` of shape `{ extends, themeTokens, intentDefaults?, traitDefaults? }`. `themeTokens` is the **only required field** — a DTCG token file (e.g. `./<id>.tokens.json`, resolved relative to the manifest) that *references*, never embeds, its tokens. `extends` resolves to `@webtheme/default` (the platform default) or another design-system id. `intentDefaults` keys must resolve to registered intents (`density`/`motion`/`surface`/…); `traitDefaults` is **presentational only** (radius/feel — Fork 4-A; behavioral-trait activation never enters the bundle).
2. Add a thin index entry to `src/_data/designSystems.json` — `{ id, name, summary, status, ownedByProject, manifest }` — so the catalog can iterate it. The `validateDesignSystem` rule in `check-standards-rules.mjs` enforces both layers; the `/design-systems/` page (`src/design-systems.njk`) and the nav entry auto-render from the index.

## Key patterns

**Injector system** — DI via DOM tree traversal:
```typescript
injector.set('customContexts:handlers', handlers);
InjectorRoot.getProviderOf(element, 'customContexts:handlers');
```

**Registry pattern** — named registration:
```typescript
attributes.define('on:click', OnClickAttribute);
parsers.define('call', new CallParser());
```

**Parser pipeline** — composable via reduce; parsers try in order, wrapping previous results:
```typescript
registry.parse('save($event) | validate'); // CallParser then PipeParser
```

## File organization
```
plugs/      bootstrap.ts · core/ · webstates/ · webinjectors/ · webbehaviors/
            webcontexts/ · webregistries/ · webcomponents/ · webexpressions/ · webdirectives/
blocks/     stores/ · parsers/ · attributes/ · router/ · view/ · tabs/ · navigation/
            for-each/ · transient/ · renderers/ · text-nodes/ · resource-loader/
demos/      declarative-spa.html and variants
```

## Common tasks
- **New store**: `blocks/stores/{name}/{Name}Store.ts` extends `CustomStore` → `index.ts` → register in `blocks/stores/index.ts` → document (see [design-first.md](./design-first.md)) → tests.
- **New parser**: implement `parse(input, context)` → `ParseResult`; include `evaluate(resolved)`; register in `plugs/bootstrap.ts`; document.
- **New event attribute**: use `createOnEventAttribute()`; register `attributes.define('on:eventname', AttributeClass)`; common events go in `registerEventAttributes()`.
- **Modify the demo**: `demos/declarative-spa.html` has a `text/plain#demo-js-source` (shown in viewer) and a `type="module"` (running) section — **keep both in sync**.

## Debugging
```typescript
for (const injector of element.injectors()) console.log(injector.providers); // injector chain
const r = registry.parse('expr'); console.log(r.success, r.expressions, r.remaining); // parser
```
Subclass `CustomAttribute` and log in `connectedCallback`/`disconnectedCallback` to trace lifecycle.

## Capacity routing and reset calendar

Build-only `routing.builder=auto` scores accounts independently. Audit and review seats retain their
own routing. `scripts/settings/provider-capacity.json` owns provider/model tiers, launchers, allowed
build kinds, reserves, readers, window models and account inventories. Add a model as one entry;
`quotaOf` aliases share observations and never add horizon capacity. Override `providerCapacity`
through the shared declared reader and policy-cascade (standard → platform → tool → environment;
operator preferences use the platform layer). Arrays replace as a whole. Effective values and sources
use the normal cascade log. `routing.capacity` owns global pacing weights, working hours, reset
thresholds and demand assumptions. Unknown readings never score; unknown horizons require operator
input. All-readers-unknown preserves the historical builder threshold only for an eligible fallback.

The pure `scripts/lib/capacity-planner.mjs` handles fixed-window end-of-window burn, rolling usage
rates and restart-on-reset inventories. Each manual reset restores a full window and forfeits the
remainder. Banked resets on hand are authoritative: grant cadence is informational and never enters
planning. Expiry deadlines use cumulative current remainder plus banked capacity, earliest expiry
first; the tightest deadline sets the required rate. With banked resets, pace and score pressure
compare current rate against this required rate, rather than the plain window curve. Codex uses
a bounded usage-ledger slope over `routing.capacity.rateLookbackHours` (default 24); at least
two observations in the current window are required. Drops in usage or changed reset timestamps
start a new window, including in historical rows without reset metadata. Other providers use
the recent decision-ledger slope. Unknown rates remain unknown. Shortfalls boost routing up to `maxBurnBoost`
(default 3) and emit a deduped burn event requesting queued audits, red teams and backlog builds.
This event requests work; it does not change audit/review provider selection.

`routing.capacity.workingHours` defaults to 09:00–20:00 America/New_York, weekdays 1–5.
Recommendations compare previous-slot forfeiture against the banked expiry loss from throttling
until the next slot; both costs appear in the calendar. Reset alerts require queued demand and
`resetAtPercent` (default 95), and occur only in working hours. Receipts dedupe by account/window
and event type. Telemetry failures never interrupt dispatch. Oversized inventories (>1000 resets)
require operator correction rather than generating an unbounded plan.

`node scripts/operations/run.mjs capacity-calendar [--json] [--horizon]` shows observations,
planner actions, rate pressure, reset choices, missing operator inputs and a 14-day forecast.
`expectedDemandPerDay` is percent-of-window units per account/provider (null means unknown).
Horizon days run midnight-to-midnight in `workingHours.tz`, including DST transitions. Banked
resets contribute capacity on their planner-selected working day, earliest expiry first; absent
forecast demand, the observed burn rate projects reset timing while expected demand stays unknown.
Inactive accounts never route or contribute capacity; sustained shortfall on three working days
(`activateAfterShortfallDays`) recommends activation. Banked inventory alone does not guarantee
demand coverage: working-hour deferrals can cause a shortfall before the next reset. Inventory-only
fixtures must supply continuous working hours. The shared Claude usage file maps only to
`routing.capacity.claudeUsageAccount`; null leaves both accounts unknown. Until launchers select accounts, routing scores only the account attributed to the live reader.
An unattributed multi-account provider is unknown. Account IDs appear only in the capacity decision
log, never in executable route results (follow-up: account-aware provider launchers).

`fix:critical-work` and `fix:ruling-escalation-stronger` remain Claude-only pins to opus and sonnet
respectively, exactly as declared in routing policy. Pinned routes bypass capacity scoring entirely;
capacity cannot select or change their provider/model. Explicit takeover and ruling-not-addressed
routes also remain Claude policy data.



### Capacity routing safety

Capacity ranks provider/model candidates; the normal routing gate, holds, vetoes, disabled-provider
and model validation still apply. Projection preserves configured effort, disabled providers and
other policy fields, and never changes non-build operations such as prepare-decision. Candidates
are tried in order; only all-unknown readers may use the historical policy fallback. Known rejected
capacity holds with named reasons and a wait/reset/clear-hold fallback. Apply capacity eligibility
both to route selection and to every returned fallback rung: the pure router's `available` input
constrains its selected route, but does not filter its returned fallback list.
A closed critical-work gate permits only Claude, including for fixes; a Codex-only route refuses.
Provider tiers remain capacity data for other configured minimum-tier constraints.
Critical takeover and ruling-not-addressed send-backs remain Claude-only and hold when Claude is unavailable.
Escalation preserves rung order while removing held, exhausted, inactive, reserve-only, disallowed
and below-minimum providers. Unknown rungs retain their configured position;
when every reader is unknown the historical effective-builder chain applies (Claude drops Codex).
`routing.capacity.operatorReadingMaxAgeHours` defaults to 24 and follows the normal cascade with
`capacitySources` provenance. Older operator readings never supply quota; the calendar reports
“operator reading stale — refresh”. Refresh the reading, restore live quota, or wait for reset/clear
holds when routing refuses. A chain decision with `executor:null` holds every launch and resume caller.

When critical or unproductive escalation requires Claude but filtering removed Claude, the chain
holds instead of continuing on Codex. An invalid AI overlay makes the fixer-ladder rung unavailable
and surfaces its error. Routing tests consume shipped defaults; injected capacity observations or
the capacity enable switch isolate quota-dependent and legacy paths without replacing route data.
`readTick` accepts `routingOptions` for hermetic dispatch tests: supply the routing policy,
repo settings, isolated preferences environment, capacity snapshot, quota reader and decision
recorder together. A Claude-only launcher fixture must not consume live Codex quota: auto
capacity can otherwise select Codex and make the fixture refuse at launch. Omitted options
retain production settings, host observations and decision persistence.
