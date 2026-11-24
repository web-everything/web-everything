# Demo Workflow — building runtime demos

> Tier-1 reference. Read when creating or changing a demo under `demos/`.
> Building one of the flagship **exercise apps** (#314)? Read [exercise-app-workflow.md](exercise-app-workflow.md) too.

## Objective & the platform-first rule (applies to every demo)

A demo exists to **exercise a standard in a real browser**, built *from* the platform. **Every codified
surface must be consumed, never re-implemented.** Before hand-writing any UI or behavior, resolve it
against the registry (`src/_data/{blocks,intents,plugs}.json`):

- **ACTIVE** block/plug/intent → **use it.** Hand-rolling an active surface (a `<table>` instead of the
  data-table block, `addEventListener` instead of `on:*`, module vars instead of a store) is a *defect*,
  not a shortcut. This includes **behavioral traits**: a covered interaction (disclosure → `nav:section`,
  roving focus → `nav:list`) **MUST compose the existing trait**, never re-wire it by hand — search the
  trait registry before wiring, and let the block declare what it consumes in `composesBehaviors`.
  Statute: [platform-decisions.md#compose-dont-handroll](platform-decisions.md#compose-dont-handroll)
  (#933; incidents #870/#931 were hand-rolled nav demos the gate now catches).
- **DRAFT** contract with no runtime → that's a **gap** — implement the runtime, or tag the scaffold
  `// PLATFORM-GAP: #NNN` against a tracked backlog item.
- **UNCODIFIED** → candidate **new standard** (`/new-standard`).

The authoring substrate is the **JSX mirror dialect** (`.tsx`) over the active blocks — not `.ts` with
`innerHTML` string-concat. The `check:app-conformance` benchmark enforces this for exercise apps; the
same spirit applies to all demos.

Demos are **runtime, interactive** pages served by Vite on **:3000** and passthrough-copied into the
11ty docs site. Each is registered in `demos.json` and surfaces at `/demos/` (index) and
`/demos/{id}/` (a detail page linking to the live `:3000` URL). Use a demo to *exercise a standard in
a real browser* — not to document it (that's the block/adapter page's job).

## Embedding a Frontier UI demo on a block page — the `fuiDemo` convention (#701/#604)

The demos above are **WE-authored** (`demos/`). A *block page* shows a **live runtime** of a block whose
implementation lives in Frontier UI — and per the docs-rendering boundary, **WE never imports or renders
FUI block code; it embeds a FUI-*hosted* demo via a sandboxed iframe** (the #700 ruling; #604). The
`fuiDemo` shortcode (defined in `.eleventy.js`, #701) is that one embed:

```njk
{% fuiDemo "<demo-file>.html", "<caption>", <heightPx> %}
```

It renders an `<iframe src="${FUI_DEMO_BASE}/demos/<demo-file>.html">` with FUI branding chrome. `FUI_DEMO_BASE`
is the FUI dev server (`:6002`) by default, or the published demos host via `FUI_DEMO_BASE` in prod —
nothing is imported across repos.

> **The WE↔FUI in-document exception (#765, ratified 2026-06-16).** The "never renders FUI in its own
> document" boundary is an *ownership* rule (FUI owns the impl **and** its rendering), not an
> *iframe-mechanism* mandate. For the **trusted WE↔FUI pair only**, a future opt-in render mode (**mode C**)
> may mount a FUI component **in-document** behind a **shadow root** via FUI's runtime embed SDK — FUI's SDK
> still does the rendering, so impl→FUI is untouched; only the iframe is dropped, letting native top-layer
> overlays escape with zero coordination (#732's escape modes A/B1/B2 stay the host-side alternative). It is
> **never** the #700 source import (no `frontierui` alias), **never** for third parties (they iframe
> permanently), and the **iframe stays the default** — a demo opts into C only where fidelity warrants. The
> mode-C build is a separately-prioritized child under #728.

> **Interactive Block-Explorer workbench: chrome is decoupled from distribution (#809, ratified 2026-06-16).**
> The live theme/trait/inspect *workbench* is a **FUI-owned, FUI-hosted** product (#815), not WE docs chrome.
> There are two FUI distributions of a block, and the **chrome rides only the iframe one**:
> - **iframe + chrome** — the workbench: chrome (switcher / trait panel / inspect panels) **and** the block
>   are served **same-origin inside one iframe**, so manipulation + inspection are intra-FUI host-side DOM
>   with **no WE↔FUI channel and no postMessage manipulation protocol**. Embeddable on **any** site (WE
>   included) via a plain `<iframe>`.
> - **in-document, no chrome** — **mode C** (above): the bare FUI component mounted inline, no workbench.
>
> A WE block "do" page embeds the workbench iframe and wraps it with a **WE-docs overlay** for the
> WE-**standards** panels (intent→ARIA mapping, token provenance, the #092 provider↔consumer graph) — WE
> data that does not travel to third-party embedders. `impl→FUI` holds throughout: FUI owns the rendering
> *and* the workbench that drives it. Re-homed slices: #749/#750/#755/#806 build `@frontierui` into #815.

**Demo→block mapping convention (so new blocks roll out as one-liners):**
- The mapping is **declared in the block's description partial** (`src/_includes/block-descriptions/<block>.njk`)
  as a single `{% fuiDemo … %}` line under a `<h3 id="try-it-live">Try it live</h3>` section — not in
  `blocks.json`. The partial already owns the block's prose, so its demo lives there too; `blocks.json`
  stays a pure registry.
- **Demo file naming:** the FUI-hosted file is `<concept>-unplugged.html` (e.g. `autocomplete-unplugged.html`
  for the droplist family) — the unplugged form is the public, non-invasive surface (#606). Confirm the file
  exists in `frontierui/demos/` before referencing it.
- **Additive, never a replacement:** keep the page's authored static code samples; the embed sits alongside
  them as the live proof. First consumers: `component.njk` (#038 converter), `autocomplete.njk` (#733, the
  droplist family).

```
demos/{id}.html        # shell: loads /plugs/bootstrap.ts + the .tsx; nothing else
demos/{id}.tsx         # the demo logic — JSX (mirror dialect) rendering real DOM
demos/{id}.css         # styles
src/_data/demos.json   # registry entry (the only file that *surfaces* the demo)
```

## 1. Register it (`demos.json`)
```json
{
  "id": "kebab-case-id",
  "name": "Human Title",
  "summary": "One line for the index card.",
  "description": "<h2>Concept</h2><p>…</p><h3>Scope</h3><p>POC/tier note…</p>",
  "status": "draft",
  "kind": "playground",                                       // marks a conformance playground; omit for a showcase
  "liveUrl": "http://localhost:3000/demos/{id}.html",
  "projects": ["webadapters"]
}
```
`projects[]` must resolve in `projects.json`. `npx @11ty/eleventy` should add one page at `/demos/{id}/`.

### The `kind` field routes the surface (#1216)

Every demo still gets a detail page at `/demos/{id}/`, but the two **index surfaces** are split by `kind`:

- **`kind: "playground"`** → listed on **`/conformance/`** (the conformance-status page). A playground is a
  headless, in-browser proof that a protocol is satisfied — framed as *project strength*, not a demo. This
  is the home for the conformance suite (`*-conformance-demo`, `*-conformance`, etc.).
- **no `kind`** (or `"showcase"`) → listed on **`/demos/`**. A showcase is WE protocols in *real action* —
  a compelling, real-usage experience integrating multiple standards.

So pick `kind` honestly: it decides which audience surface advertises the demo. `kind: "demo"` and other
stray values are **invalid** — a missing `kind` already means showcase. Don't conflate the two surfaces on
one index (the pre-#1216 `/demos/` mixed 36 playgrounds with 9 showcases, burying the real-action work).

## 2. Bootstrap (the `.html` shell)
Load the platform bootstrap, then the demo module:
```html
<script type="module" src="/plugs/bootstrap.ts"></script>   <!-- exposes window.{CustomAttribute, injectors, attributes} -->
<script type="module" src="/demos/{id}.tsx"></script>
```
The **JSX factory is auto-injected** by `vite.config.mts` (`jsxInject` → `/blocks/renderers/jsx`), so
write JSX directly in the `.tsx`; it renders real DOM through the realigned renderer in the
**mirror dialect** (`class`/`for`, `on:*` string behaviors, `bind-*`, `<template is="…">`). Declare
the factory for tooling: `declare const jsx: typeof import('/blocks/renderers/jsx').default;`.

> **Bootstrap is auto-injected** into *every* demo HTML by `vite.config.mts` (`webEverythingPatches`),
> so the `<script src="/plugs/bootstrap.ts">` tag above is **optional** — include it only to be explicit.
> To skip injection entirely, suffix the name `-unplugged`.
> **JSX and bootstrap are available, not mandatory.** A demo that needs no WE plugs should be a plain
> `.ts` with native DOM APIs — fewer moving parts (e.g. `component-adapter-demo.ts`, which registers
> custom elements with no renderer/bootstrap dependency).

## 3. Pick the pattern
- **Showcase / SPA** — build an interactive app from the standards (e.g. `declarative-spa`).
- **Playground / conformance** (preferred for adapters & standards) — render each example live, show
  its source, and a **pass/fail badge** proving an invariant (e.g. `JSX→DOM == canonical`). See
  `demos/jsx-adapter-demo.tsx` as the reference.
  - **Drive examples from a shared fixture module**, imported by *both* the demo and the unit tests,
    so the badges and the tests can never drift.
  - **Share the chrome, don't re-roll it.** Fixtures stop *example* drift; the card/badge/summary/
    DOM-equality machinery and the `.play`/`.summary`/`.badge`/`.ex` CSS must come from **one shared
    source** (a `playground-harness.ts` + `playground.css`), imported — never copy-pasted. The two
    existing playgrounds already drifted ~80 CSS lines from copy-paste; retrofit a playground onto the
    shared harness when you touch it. *(Shared harness not yet extracted — first playground work to do
    so should create it.)*
  - **Name the invariant the badge proves** in the UI, and prefer proving the standard's *documented
    guarantees* over happy-path rendering: equivalence/round-trip (two-way, e.g. JSX⇄HTML), lowering
    fidelity (one-way, e.g. `<component>`→class), or determinism/idempotency. Include **negative/edge
    cases** (invalid input, error paths), not only passing ones.
  - **Expose a readiness flag + counts** on `window` (e.g. `window.playgroundReady = true`,
    `window.playgroundPass = n`) so an E2E spec can assert them.
  - **Registering custom elements?** `customElements.define` is **one-shot per tag** — an editable /
    re-running playground must **uniquify the tag** each run, and make `connectedCallback` idempotent
    (`if (!root.childNodes.length)`) so re-render / Declarative-Shadow-DOM hydration is safe.

## 4. Source toggle (docs pages — not the runtime demo)
To show the same element as HTML and JSX on a block/adapter page (`source-toggle.njk`):
- **`autoToggle(id, html)`** — author the HTML once; the JSX pane is **generated at build time** via
  the `htmlToJsx` filter. Requires **parseable HTML** (no comments inside a start tag, etc.).
- **`sourceToggle` / `jsxSource` / `endSource`** — manual panes; use for annotated or pseudo-HTML
  snippets that won't parse.

## 5. Testing (mandatory — details in [testing.md](testing.md) and the coverage plan)

Add new testing notes as per-topic files in [testing.d/](testing.d/README.md).

- **Logic** → unit tests over the **shared fixtures** (`*.test.ts`, Vitest). Adding a mapping/behavior
  case = adding one fixture, which covers the demo and the tests at once.
- **Browser runtime** → an **E2E spec** at `{plugs|blocks}/__tests__/e2e/{id}.spec.ts` (Playwright):
  the demo loads, the readiness flag is `true`/counts are as expected, and **no console errors**.
  Run with `npm run test:integration` — the dev server must be running (`webServer` is commented out
  in `playwright.config.ts`; baseURL is `:3000`).
- **Build integrity** → `npx @11ty/eleventy` must build with no template error (a missing njk import
  aborts the *whole* build).

## 6. Routed folder demos (mounted under a base path)

A multi-view app (the flagship exercise apps) is a **folder demo**: `demos/{id}/{index.html, app.ts,
app.css, conformance.json}`, served at the **base path `/demos/{id}/`** — *not* the origin root. Its
client-side router therefore lives in **base-qualified URL space**, and getting that wrong is a
recurring, easy-to-miss bug: the app boots fine but a **hard reload of a deep route 404s** because a
redirect/link dropped the base (and the dev server had no SPA fallback for it).

The Router block already ships the mechanism — **use it, don't hand-roll a `replaceState` shim**:

- **`<route-view base="/demos/{id}" entry="/home">`** — `base` prepends to every `route="/x"` pattern
  (matching), and `entry` (#365) maps the load-time URL into route space (replaces the boot shim).
- **`base` does NOT apply to `route:link` hrefs or programmatic redirects** — those navigate to their
  raw value. Route them through a single seam: `const routePath = (p) => \`/demos/{id}${p}\`;` and use
  `route:link="${routePath('/x')}"`. Never emit an origin-root-absolute `route:link="/x"` or
  `history.replaceState(null, '', '/x')`.
- **Add a `routerDemoFallback` entry in `vite.config.mts`** mapping `/demos/{id}/<route>` →
  `/demos/{id}/index.html`, so a hard reload of a deep route is served the SPA entry instead of 404ing
  (the dev-server half the block can't do from inside the page).

This wiring is gated automatically — see below. (The `loan-origination` and `auto-insurance` exercise
apps moved to FUI in #823/#824 and are now embedded via the `fuiDemo` iframe, not served from WE.)

## 7. Quality gates for demos — `check:demos`

Two complementary, **shared** validators guard every demo (don't hand-roll per-demo checks):

- **`npm run check:app-conformance -- --app=demos/{id}`** — does the app *use* the standards it declares
  in `conformance.json` (vs reimplement)? (See [exercise-app-workflow.md](exercise-app-workflow.md).)
- **`npm run check:demos`** — **operational wiring**, folded into `check:standards` so it runs every
  time: every folder demo is registered; every routed folder demo sets `base`+`entry`, carries no
  origin-root-absolute link/redirect literal, and has a `routerDemoFallback` entry. Add **`--live`** to
  probe a running dev server (entry + every deep route reload return 200 — the exact regression).

**The manual checklist is generated, not hand-copied.** `npm run check:demos -- --write-checklist`
(re)writes `demos/{id}/CHECKLIST.md` from `demos.json` + `conformance.json` + parsed routes. Everything
above the `## Demo-specific` marker is regenerated; hand-authored notes below it are preserved. Edit
metadata, not the generated sections.

## 8. Verify checklist
- [ ] Single-file: `demos/{id}.{html,tsx,css}` created. Folder: `demos/{id}/{index.html,app.ts,app.css,conformance.json}`.
- [ ] `demos.json` entry added (valid JSON); `npx @11ty/eleventy` builds; `/demos/{id}/` page appears.
- [ ] Vite serves the entry (200) and transforms the source (no errors).
- [ ] **Routed folder demo**: `<route-view base/entry>` set; links/redirects base-qualified via a seam;
      `routerDemoFallback` entry added. **`npm run check:demos` passes** (it's in `check:standards`).
- [ ] `npm run check:demos -- --write-checklist` run; `CHECKLIST.md` reviewed (`## Demo-specific` filled).
- [ ] Logic covered by unit tests over a shared fixture module.
- [ ] E2E spec added; `npm run test:integration` green with the dev server up.
- [ ] `status` starts `draft`; description states the POC/tier scope.
