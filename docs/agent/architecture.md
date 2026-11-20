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

## Confined agy transcript ownership

The adapter is an inactive prototype: `AGY_BUILD_CONFINEMENT.mode` remains `unavailable`,
production launch paths refuse and routing uses the next provider. The current sandbox
profile denies network access. Neither small-job settings nor filed prevention cards enable
production. The outstanding credential, executable-test, process-lifetime and live-proof
requirements are mapped under “Confined Antigravity build adapter” in `docs/agent/testing.md`.

Keep build transcripts in a fresh launcher-owned 0700 temp directory outside every sandbox write grant,
private HOME, clone, lane and workspace. The profile builder refuses overlaps; the launcher uses exclusive
no-follow creation and retains the regular-file fd for writes. Audit before deleting the directory.
