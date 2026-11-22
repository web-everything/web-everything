---
bornAs: xs1i22b
kind: story
size: 8
status: closed
closedReason: fixed-elsewhere
closedBy: "plan step DZ-SHELL"
dateClosed: "2026-11-22"
blockedBy: ["2510"]
dateOpened: "2026-07-15"
preparedDate: "2026-08-15"
tags: []
scope:
  - plateau-app:index.html
  - plateau-app:src/main.ts
  - plateau-app:src/explorer-runs/runsPage.ts
  - plateau-app:src/backlog-view/backlog-view.ts
  - plateau-app:src/backlog-view/ruling-surface.ts
  - plateau-app:src/backlog-view/mount.test.ts
  - plateau-app:src/backlog-view/ruling-surface.test.ts
  - plateau-app:src/explorer-runs/runsPage.test.ts
  - plateau-app:tests/visual/board.visual.spec.ts
  - plateau-app:tests/e2e/
---

# Migrate plateau-app routes into per-product subtrees (extraction-ready)

Follow-up to #2510 (thin product shell, merged `plateau-app` PR #46, on `main` at `226902a`). Rename
plateau-app's flat tool routes into per-product subtrees — `/intent-configurator` becomes
`/studio/intent-configurator`, `/explorer-runs` becomes `/explorer/runs`, etc. — so each product owns a route
subtree that can later move as a route-move, not a rewrite (the extraction-ready property ratified in #2476,
feeding #2446). `blockedBy: ["2510"]` is now satisfied (#2510 resolved 2026-07-15).

**#2510's own nav groups (`plateau-app:index.html:56-115`, live today) are the product boundaries this story
routes under** — no new grouping decision needed, only the prefix-and-redirect mechanics.

## Route mapping (the decided design — every renamed path, no menu)

Rule: keep the path segment unchanged when nesting it under its product prefix, **except** drop a segment
that repeats the product name (stutter-avoidance) — the one rule the card's own example already applies
(`/explorer-runs` → `/explorer/runs`, not `/explorer/explorer-runs`). Applied consistently below to
`/platform-map`, `/brand-library`, `/web-docs`. `/`, `/settings`, `/brand`, and every public/marketing/auth
route (`/home`, `/login`, `/signup`, `/reset`, `/deck*`, `/pricing`, `/constitution`, `/terms`, `/privacy`)
are **unchanged** — they sit outside any product's `nav:section` panel today and stay that way.

| Product (nav:section id) | Prefix | Old path | New path |
| --- | --- | --- | --- |
| Platform Manager (`#prod-platform`) | `/platform` | `/apps` | `/platform/apps` |
| | | `/apps/:id` | `/platform/apps/:id` |
| | | `/libraries` | `/platform/libraries` |
| | | `/profiles` | `/platform/profiles` |
| | | `/control-plane` | `/platform/control-plane` |
| | | `/governance-ui` | `/platform/governance-ui` |
| | | `/compatibility-map` | `/platform/compatibility-map` |
| | | `/impact-analysis` | `/platform/impact-analysis` |
| | | `/contract-drift` | `/platform/contract-drift` |
| | | `/platform-map` | `/platform/map` (stutter-strip) |
| Design-System Studio (`#prod-studio`) | `/studio` | `/intent-configurator` | `/studio/intent-configurator` |
| | | `/technical-configurator` | `/studio/technical-configurator` |
| | | `/project-config-discovery` | `/studio/project-config-discovery` |
| | | `/design-system-creator` | `/studio/design-system-creator` |
| | | `/component-assembler` | `/studio/component-assembler` |
| | | `/vision-review` | `/studio/vision-review` |
| | | `/design-review` | `/studio/design-review` |
| | | `/weight-tuning` | `/studio/weight-tuning` |
| Explorer (`#prod-explorer`) | `/explorer` | `/explorer-runs` | `/explorer/runs` |
| | | `/explorer-history` | `/explorer/history` |
| Plateau Loop (`#prod-loop`) | `/loop` | `/backlog` | `/loop/backlog` |
| | | `/backlog/:id` | `/loop/backlog/:id` |
| | | `/console-board` | `/loop/console-board` |
| | | `/console-cases` | `/loop/console-cases` |
| | | `/console-ruling` | `/loop/console-ruling` |
| | | `/console-micro` | `/loop/console-micro` |
| Brand (`#prod-brand`) | `/brand` | `/brand-library` | `/brand/library` (stutter-strip) |
| | | `/brand` | unchanged — already the product's own prefix root |
| Docs (`#prod-docs`) | `/docs` | `/learn` | `/docs/learn` |
| | | `/skills` | `/docs/skills` |
| | | `/web-docs` | `/docs/web` (stutter-strip) |
| — standalone, outside any panel | — | `/`, `/settings` | unchanged |

No new bare-prefix routes (`/platform`, `/studio`, `/loop`, `/docs`) are created — the `nav:section` buttons
that head each group are plain `<button nav:section="#prod-x">`, not `route:link`s
(`plateau-app:index.html:59,72,84,92,101,107`), so these words are path **prefixes**, not routes in their own
right, today or after this change.

## Consumer sweep (verified against `plateau-app` `main` @ `226902a`, precise grep — not the loose substring
match that over-fires on words like "learn"/"skills"/"profiles" in prose)

Every literal old-path reference, by file:

- **`plateau-app:index.html`** — 26 `<a route:link="...">` sidebar hrefs that rename (lines 61-111, incl.
  `/brand-library` and the whole Docs group — corrected by independent review, 2026-08-15: the first pass
  undercounted this as "25... lines 61-96") + 30 matching `<template route="...">` entries (lines 164-566,
  incl. `/brand-library`, `/apps/:id`, and `/backlog/:id`). The mapping table above is the source of truth
  either way — every renaming pattern is listed there regardless of the count.
- **`plateau-app:src/main.ts`** — the `PRODUCT_ROUTES` array (`plateau-app:src/main.ts:268-274`, 25
  entries), the `updateBreadcrumb` labels map keys (`plateau-app:src/main.ts:295-319`), ~25
  `if (path === '/old') tryMountX()` conditionals in the `route-change` listener
  (`plateau-app:src/main.ts:398-430`), and two hand-built hrefs at `plateau-app:src/main.ts:449`
  (`/apps/${app.id}`) and `plateau-app:src/main.ts:481` (`/apps`).
- **`plateau-app:src/explorer-runs/runsPage.ts`** — a `route:link="/explorer-history"` at
  `plateau-app:src/explorer-runs/runsPage.ts:111` and an `href="/explorer-history?run=${...}"` at
  `plateau-app:src/explorer-runs/runsPage.ts:52` (query string carried).
- **`plateau-app:src/backlog-view/backlog-view.ts`** — `location.pathname.match(/^\/backlog\/(.+)$/)` at
  `plateau-app:src/backlog-view/backlog-view.ts:63` (deep-link id parse), the xref href builder at
  `plateau-app:src/backlog-view/backlog-view.ts:558` and `:560`, two
  `history.pushState(..., '/backlog/${...}')` calls at `plateau-app:src/backlog-view/backlog-view.ts:901`
  and `:919`.
- **`plateau-app:src/backlog-view/ruling-surface.ts`** — an `href="/console-micro?repo=...&decision=..."`
  deep link at `plateau-app:src/backlog-view/ruling-surface.ts:228` (query string carried).
- **Tests**: `plateau-app:src/backlog-view/mount.test.ts` (19 `pushState('/backlog...')` fixtures —
  list/id/query variants — **plus 3 more literal `/backlog` references independent review found**:
  `plateau-app:src/backlog-view/mount.test.ts:247` and `:260`
  (`expect(location.pathname).toBe('/backlog/NNNN')`) and `:603`
  (`expect(assign).toHaveBeenCalledWith('/backlog?repo=plateau-app')`) — 22 total),
  `plateau-app:src/backlog-view/ruling-surface.test.ts` (2 `href="/backlog/..."` assertions + 3
  `pushState('/console-ruling')` calls **plus one more independent review found**:
  `plateau-app:src/backlog-view/ruling-surface.test.ts:331`,
  `window.history.replaceState({}, '', '/console-ruling?repo=webeverything&decision=2560')` — 4 total),
  `plateau-app:src/explorer-runs/runsPage.test.ts` at line 59 (1 href assertion),
  `plateau-app:tests/visual/board.visual.spec.ts` at line 45 (`page.goto('/console-board?demo=1', ...)`).
- **NOT affected, verified**: `plateau-app:tests/e2e/auth-shell-split.spec.ts` — the card's original text
  listed this as needing an update; it doesn't. It only exercises `/home`, `/login`, `.app-shell.logged-off`;
  sign-in/out (`plateau-app:src/main.ts:204,215,227`) navigate to `/` and `/login`, neither of which moves.
- **NOT affected**: `PUBLIC_ROUTES` (`plateau-app:src/main.ts:263`) and loader/guard names (`loadApps`,
  `requireAuth`, …) — loaders/guards are keyed by name, not path, and the public marketing routes are
  untouched.

## The redirect mechanism — the risky part, de-risked during prep, not left to the build

**Claim verified against the router source `plateau-app` actually consumes** — corrected by independent
review, 2026-08-15: the first pass of this card cited `we:blocks/router/` (the WE *standard*-layer copy),
but `plateau-app:src/main.ts:10` imports `@frontierui/plugs/bootstrap`, which wires `registerRouter` from
`frontierui:blocks/router/registerRouter.ts` — the *impl*-layer router products actually run (the
constellation split already on record: WE = standard, FrontierUI = impl). The two copies have diverged
(FrontierUI's carries `RuntimeRouteObject`/`mergePrecedence`/`compileRuntimeRoutes` machinery WE's lacks, a
different `observedAttributes` set, and no route-config schema file at all — so the schema-only
`RouteRedirect` type this card originally cited (`we:blocks/router/route-config.ts:65-98`) doesn't exist in
the router plateau-app actually runs). Every behavioral claim below was re-verified against
`frontierui:blocks/router/` directly and **all hold**; only the citations moved:

- `route-view` (`frontierui:blocks/router/elements/RouteViewElement.ts`) has **no** native `route:redirect`
  attribute — only `route:guard`, `route:guard-leave`, `route:loader`, `route:outlet`, `route:error` are
  recognized (`frontierui:blocks/router/types.ts:182-190` and `:318-328`).
- When no `<template>` matches a path and the `/*` wildcard fires, `detail.to.path` on the `route-change`
  event is still the **original, unmatched pathname** — `matchRoute`
  (`frontierui:blocks/router/types.ts:448-471`) never rewrites the input `URL`, and `buildNavigationTarget`
  (`frontierui:blocks/router/types.ts:540-547`) sets `path: matched.url.pathname` off that same object
  regardless of which pattern matched. So an app-level listener can reliably read the real old path even
  after every `<template route="/old-path">` entry is deleted.
- `route-change` fires on the **very first render**, not just later navigations — `connectedCallback`
  (`frontierui:blocks/router/elements/RouteViewElement.ts:134-153`) unconditionally runs
  `#handleNavigation` on init, which dispatches `route-change`
  (`frontierui:blocks/router/elements/RouteViewElement.ts:433-436`) after stamping. `syncAuthShell`
  (`plateau-app:src/main.ts:279`) already depends on this; confirmed correct by reading the source, not
  inferred.
- Calling `navigate(newPath, {replace:true})` from inside a `route-change` listener is safe: it re-runs
  `matchRoute`/`#handleNavigation` for the new path and dispatches a **fresh** `route-change` for it — no
  loop, since the redirect table has no entry for any *new* path.
- `detail.to.path` is **pathname only** — `buildNavigationTarget` splits `url`/`path`/`query`/`hash`
  separately. A redirect that doesn't reattach `detail.to.url.search` silently drops query strings, which
  breaks the three query-carrying links this story has (`/explorer-history?run=`, `/console-board?demo=1`,
  `/backlog?repo=`).

**Decided design**: delete the old `<template route="/old">` entries outright (no dual-template scheme —
the wildcard-fallthrough path above makes that unnecessary complexity). Add a small ordered prefix table +
helper in `plateau-app:src/main.ts`, checked **first**, before `syncAuthShell`, in the `route-change`
listener:

```ts
// Legacy flat-path -> per-product-subtree redirects (#2512). Old bookmarks/links still resolve: the router's
// wildcard `/*` still fires `route-change` with the ORIGINAL (unmatched) pathname in `detail.to.path` even
// when no template matches, so this check runs first and short-circuits via navigate(..., {replace:true});
// the second route-change that triggers resolves normally against the new template. Runs BEFORE
// syncAuthShell so an anonymous visitor's old-URL bookmark reaches the auth gate on the CANONICAL path, not
// the retired one.
const LEGACY_ROUTE_PREFIXES: [string, string][] = [
  ['/apps', '/platform/apps'],
  ['/libraries', '/platform/libraries'],
  ['/profiles', '/platform/profiles'],
  ['/control-plane', '/platform/control-plane'],
  ['/governance-ui', '/platform/governance-ui'],
  ['/compatibility-map', '/platform/compatibility-map'],
  ['/impact-analysis', '/platform/impact-analysis'],
  ['/contract-drift', '/platform/contract-drift'],
  ['/platform-map', '/platform/map'],
  ['/intent-configurator', '/studio/intent-configurator'],
  ['/technical-configurator', '/studio/technical-configurator'],
  ['/project-config-discovery', '/studio/project-config-discovery'],
  ['/design-system-creator', '/studio/design-system-creator'],
  ['/component-assembler', '/studio/component-assembler'],
  ['/vision-review', '/studio/vision-review'],
  ['/design-review', '/studio/design-review'],
  ['/weight-tuning', '/studio/weight-tuning'],
  ['/explorer-runs', '/explorer/runs'],
  ['/explorer-history', '/explorer/history'],
  ['/backlog', '/loop/backlog'],
  ['/console-board', '/loop/console-board'],
  ['/console-cases', '/loop/console-cases'],
  ['/console-ruling', '/loop/console-ruling'],
  ['/console-micro', '/loop/console-micro'],
  ['/brand-library', '/brand/library'],
  ['/learn', '/docs/learn'],
  ['/skills', '/docs/skills'],
  ['/web-docs', '/docs/web'],
];
function redirectLegacyPath(path: string): string | null {
  for (const [oldPrefix, newPrefix] of LEGACY_ROUTE_PREFIXES) {
    if (path === oldPrefix) return newPrefix;
    if (path.startsWith(`${oldPrefix}/`)) return newPrefix + path.slice(oldPrefix.length);
  }
  return null;
}
```

Wired as the first lines inside the existing listener:

```ts
routeView?.addEventListener('route-change', (e: Event) => {
  const detail = (e as CustomEvent).detail;
  const path = detail?.to?.path || '/';
  const legacyTarget = redirectLegacyPath(path);
  if (legacyTarget) {
    (routeView as any)?.navigate(`${legacyTarget}${detail?.to?.url?.search || ''}`, { replace: true });
    return;
  }
  if (syncAuthShell(path)) return;
  // ...unchanged from here
```

`PRODUCT_ROUTES` (`plateau-app:src/main.ts:268-274`) gets the **same 25 entries, renamed 1:1** to their new
prefixed form — preserving today's exact membership. Do **not** add `/skills`/`/console-board`/
`/console-cases`/`/console-ruling`/`/console-micro`'s new prefixed forms to `PRODUCT_ROUTES` — they aren't in
it today either (a pre-existing auth-gate gap, out of scope here — see Watch for). Internal cross-link
generators (the Explorer Runs → History link, the backlog xref hrefs, the `console-micro` deep link) are
updated to point **directly** at the new paths, not left to round-trip through the redirect.

## Tasks

1. Add `LEGACY_ROUTE_PREFIXES` + `redirectLegacyPath()` to `plateau-app:src/main.ts`, wired first in the
   `route-change` listener, per the interface above (query-string preserved via `detail.to.url.search`).
2. Rename all 25 `<template route="...">` paths and all 25 sidebar `<a route:link="...">` hrefs in
   `plateau-app:index.html` per the mapping table. Leave `/`, `/settings`, and every public/auth `<template>`
   untouched.
3. In `plateau-app:src/main.ts`: rename all 25 `PRODUCT_ROUTES` entries, all `updateBreadcrumb` labels-map
   keys, all `if (path === '/old') tryMountX()` literals, and the two hand-built `/apps` hrefs
   (`plateau-app:src/main.ts:449` and `:481`) — all to the new prefixed paths.
4. Update internal cross-link generators to the new paths directly: `plateau-app:src/explorer-runs/runsPage.ts`
   (`/explorer-history` → `/explorer/history`, both sites, query preserved),
   `plateau-app:src/backlog-view/backlog-view.ts` (`/backlog` → `/loop/backlog`: the `:63` regex, the
   `:558`/`:560` xref href builder, the `:901`/`:919` `pushState` calls),
   `plateau-app:src/backlog-view/ruling-surface.ts` (`/console-micro` → `/loop/console-micro` at `:228`).
5. Update test fixtures: `plateau-app:src/backlog-view/mount.test.ts` (19 `pushState` literals + the
   `location.pathname`/`assign` assertions at lines 247, 260, 603 — 22 literal `/backlog` references
   total), `plateau-app:src/backlog-view/ruling-surface.test.ts` (2 href assertions + 3
   `pushState('/console-ruling')` calls + the `replaceState('/console-ruling?...')` call at line 331 — 6
   references total), `plateau-app:src/explorer-runs/runsPage.test.ts` line 59 (1 href assertion),
   `plateau-app:tests/visual/board.visual.spec.ts` line 45 (`/console-board?demo=1` →
   `/loop/console-board?demo=1`).
6. Add a new Playwright e2e spec (e.g. `plateau-app:tests/e2e/route-migration-redirects.spec.ts`, mirroring
   `plateau-app:tests/e2e/auth-shell-split.spec.ts`'s shape) that navigates directly to a representative
   sample of OLD paths — at least one static (`/intent-configurator`), one dynamic-id (`/backlog/2517` if a
   fixture id exists, else any id), and one query-string case (`/console-board?demo=1`) — and asserts the
   resolved `location.pathname` (and, for the query case, `location.search`) equals the new path, with no
   visible 404 flash (assert the real page content mounts, not the `notfound-mount` element).
7. Doc hygiene (small, same-PR): fix the stale `plateau-app:index.html:55` comment ("route-prefix
   migration... is the #2511 follow-up" — wrong number; #2511 is an unrelated resolved build-fix task, the
   real follow-up is this item, #2512) and `plateau-app:docs/backlog-console-design.md:540`'s mention of the
   old `/console-cases` path.
8. Run `npm test`, `npm run test:e2e`, `npm run build` locally (in `plateau-app`). Grep-sweep
   `plateau-app:src/` + `plateau-app:index.html` for every OLD path string from the mapping table; the only
   remaining hits should be inside `LEGACY_ROUTE_PREFIXES` itself.

## Done when

- [ ] Every sidebar `route:link` and every `<template route="...">` in `plateau-app:index.html` uses the new
      prefixed path for all 25 renamed routes; `/`, `/settings`, and the public/auth routes are untouched.
- [ ] `PRODUCT_ROUTES` and the `updateBreadcrumb` labels map (`plateau-app:src/main.ts`) use only new
      prefixed paths for the renamed set; `isProductRoute()`'s membership is otherwise unchanged (still
      excludes `/skills` and the four `/console-*` routes, matching today's behavior exactly).
- [ ] Navigating directly to an old flat path — static, dynamic-id, and query-string cases — client-side
      redirects (`replace`) to the new path, preserving the id/query, with no visible 404 flash. Proven by
      the new Playwright spec (task 6), not asserted by inspection alone.
- [ ] All internal cross-links (`plateau-app:src/explorer-runs/runsPage.ts`,
      `plateau-app:src/backlog-view/backlog-view.ts`, `plateau-app:src/backlog-view/ruling-surface.ts`)
      point at new paths directly — a grep for each OLD path string across `plateau-app:src/` +
      `plateau-app:index.html` returns zero hits outside `LEGACY_ROUTE_PREFIXES`.
- [ ] `npm test` (vitest) green, including the updated `plateau-app:src/backlog-view/mount.test.ts`,
      `plateau-app:src/backlog-view/ruling-surface.test.ts`, `plateau-app:src/explorer-runs/runsPage.test.ts`.
- [ ] `npm run test:e2e` (playwright) green, including `plateau-app:tests/e2e/auth-shell-split.spec.ts`
      (unchanged, still passes), the updated `plateau-app:tests/visual/board.visual.spec.ts`, and the new
      redirect spec.
- [ ] `npm run build` (vite) succeeds.

## Delivery shape

**One `plateau-app` PR, one branch** — not incremental. A half-renamed state breaks navigation immediately:
if `plateau-app:index.html`'s templates move before `PRODUCT_ROUTES`/the mount conditionals in
`plateau-app:src/main.ts` do (or vice versa), routes stop matching or the auth gate misfires. This mirrors
how #2510 landed (`plateau-app` PR #46).

**Named slice option, per the size-8 threshold** (checklist item 2: name the seam rather than force a
number): the six product groups (Platform Manager / Studio / Explorer / Loop / Brand / Docs) touch mostly
disjoint line ranges in `plateau-app:index.html`/`plateau-app:src/main.ts` and could land as six sequential
PRs. **Not recommended** — the shared arrays/tables (`PRODUCT_ROUTES`, the labels map,
`LEGACY_ROUTE_PREFIXES`) need a touch in every slice regardless, the work is entirely mechanical (a rename
table, no per-slice judgment), and six PRs would pay repeated review overhead for a change with no natural
partial-ship value (an old bookmark for a not-yet-migrated group would 404 instead of redirecting
mid-rollout). Kept as one item.

## Watch for

- **Redirect must run before `syncAuthShell`.** If reordered, an anonymous visitor's old-URL bookmark would
  be evaluated against the auth gate on the *retired* path instead of the canonical one.
- **Query strings.** `detail.to.path` is pathname-only; forgetting `detail.to.url.search` silently drops
  `?run=`, `?demo=1`, `?repo=` on the three query-carrying links this story touches.
- **Do not "fix" the pre-existing auth-gate gap here.** `/skills`, `/console-board`, `/console-cases`,
  `/console-ruling`, `/console-micro` are absent from `PRODUCT_ROUTES` today, so a logged-off visitor who
  types one of those URLs directly is not bounced to `/home` (`isProductRoute()` returns `false` for them,
  and `.app-shell.logged-off .app-main` is not hidden by CSS — `plateau-app:src/styles/layout.css:331-337`
  only re-centers it). This is real but orthogonal to a route rename; filed separately (see below) rather
  than silently fixed or silently carried forward unnoticed.
- **`/brand` itself does not move** — it's already the product's own prefix root; only `/brand-library`
  gains the `/brand/` prefix.

## Independent review — 2026-08-15 (checklist item 9, applied to this card itself)

**Confidence: High** (Medium as originally drafted — the redirect-mechanism citations pointed at the wrong
router copy; corrected below, and every behavioral claim held once re-checked against the right one).

Independently reviewed in a separate session, against the live tree (`plateau-app` `main` @ `0d0ed9e`,
confirmed `226902a`/PR #46 an ancestor). 25+ `plateau-app` file:line citations spot-checked and confirmed
exact (`PRODUCT_ROUTES` at `plateau-app:src/main.ts:268-274`, the breadcrumb labels map at `:295-319`, the
mount conditionals at `:398-422`, the `plateau-app:src/backlog-view/backlog-view.ts`,
`plateau-app:src/backlog-view/ruling-surface.ts`, and `plateau-app:src/explorer-runs/runsPage.ts` sites,
the test fixture counts, the stale `#2511` doc comment, the pre-existing auth-gate gap). The redirect
design itself — wildcard-fallthrough preserves the original pathname, `route-change` fires on first
render, re-navigating from inside the listener is loop-safe, no native `route:redirect` exists — holds
against the router plateau-app actually runs, confirmed independently a second time (this session) after
the correction below. `plateau-app:tests/e2e/auth-shell-split.spec.ts` genuinely needs no changes, as
claimed.

**Corrections applied by this review** (risk names per `we:backlog/3103-*.md`):

- **premise (major)** — the "redirect mechanism" section verified its claims against
  `we:blocks/router/` (WE's standard-layer copy of the router) instead of `frontierui:blocks/router/` (the
  impl-layer copy `plateau-app:src/main.ts:10` actually imports via `@frontierui/plugs/bootstrap`). The two
  have diverged; WE's copy has no analogue for FrontierUI's newer runtime-route machinery, and FrontierUI's
  router has no route-config schema file at all (so the schema-only `RouteRedirect` type this card
  originally cited doesn't exist in the router that runs). Every behavioral claim was re-verified against
  the correct file and all hold — only the citations were wrong. Corrected in the "redirect mechanism"
  section above with the right file:line anchors.
- **premise (minor)** — the Consumer Sweep's own counts undercut its "precise grep" framing: it claimed 25
  sidebar `route:link` hrefs (actually 26, lines 61-111, missing `/brand-library` and the whole Docs group)
  and 25 `<template route=...>` entries (actually 30, lines 164-566, missing `/brand-library`). Not a
  functional gap — the mapping table itself already lists every renaming pattern correctly, including
  brand-library/learn/skills/web-docs — but the false counts could mislead a verifier who trusts the number
  instead of re-grepping. Corrected above.
- **consumer (minor)** — four literal old-path references the sweep missed, all in test fixtures:
  `plateau-app:src/backlog-view/mount.test.ts:247`, `:260` (`location.pathname` assertions) and `:603`
  (an `assign` assertion), plus `plateau-app:src/backlog-view/ruling-surface.test.ts:331` (a `replaceState`
  call, not `pushState`). Low severity — Task 8's full grep-sweep and the `npm test` gate (Done-when 5)
  would force a builder to catch these even with the old undercount, since the fixtures would fail against
  the renamed app regardless — but Task 5 now names them explicitly so nobody has to discover them via a
  red test.

**Residual risks**: **legibility** (low — the corrected counts remove the false-precision framing;
the mapping table was always the real source of truth), **decorative-guard** (low, pre-existing and
explicitly named in Watch for — `isProductRoute()`/`PRODUCT_ROUTES` carry no test coverage today or after
this change; Done-when bullet 2 is provable only by inspection, unlike bullet 3's Playwright-backed
redirect proof), **consumer** (low — reviewer additionally swept `plateau-app:packages/`,
`plateau-app:tools/explorer/`, `plateau-app:scripts/`, and the other e2e spec for hardcoded old-path
references and found none beyond what's now listed; the `technical-configurator` seed files'
`/backlog/NNN-slug/` hrefs point at the WE docs site, not plateau-app's own route, correctly out of scope).

Superseded 2026-11-22 by plan step DZ-SHELL (Per-product route subtrees conflict with the five task-based sections. Keep the extraction-ready property (#2476) through module boundaries, not URL prefixes. Operator to confirm.) [PL-WIP-CLEANUP / plateau rulings].
