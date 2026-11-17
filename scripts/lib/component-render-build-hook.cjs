/**
 * @file scripts/lib/component-render-build-hook.cjs
 * @description WE Eleventy build orchestration for the SSR component-render harness (#2016, keystone of
 *   the #777 WE-docs dogfood epic).
 *
 *   The general build-time component→HTML render path, modeled on the data-table hook
 *   (`scripts/lib/data-table-build-hook.cjs`). Given a declarative spec for a `we-card` / `we-badge` /
 *   `we-tag` surface it returns ready-to-paint SSR HTML, so a catalog page renders correctly with JS
 *   disabled and the client custom-element upgrade (`src/_layouts/base.njk`) becomes a pure enhancement.
 *
 *   **Render-from-data, not markup-as-source (#2007).** Card/badge/tag own their rendered shape, so under
 *   the ratified feed-mechanism rule they are fed inert *data* — this hook composes a declarative spec and
 *   the FUI harness emits the canonical shape. It does NOT scan authored light-DOM as source. The emitted
 *   HTML is byte-identical to what the transient `<we-card>`/`<we-badge>`/`<we-tag>` elements upgrade to,
 *   so the SSR page carries the finished native element (no `<we-*>` wrapper) — nothing to re-upgrade,
 *   idempotent by construction.
 *
 *   WHY a subprocess and not an import: the block factories (`createCard`/`createBadge`/`createTag`) live
 *   in FUI; a WE→FUI code import is a banned backward DAG edge (constellation-placement). So WE
 *   orchestrates the FUI compute over a process boundary — keyed-batch JSON in on stdin, keyed-batch
 *   `{producer, results:[{key, html|error}]}` out on stdout. ONE subprocess renders every component on a
 *   page (no per-tile spawn storm).
 *
 *   The CLI is resolved as a LOCKED build-artifact at a FIXED relative path, never PATH-resolved (the
 *   #1867 reproducibility amendment carried over). FUI's `npm run build:tools` (#1946/#2016) emits it; a
 *   missing artifact is a hard build error, never a silent skip.
 *
 *   Authored as CommonJS so the sync-only Eleventy 2.x config can `require` it directly.
 */

const path = require('node:path');
const fs = require('node:fs');
const { runCliToFile } = require('./run-cli-batch.cjs');

/**
 * The pinned FUI build-artifact — a FIXED relative path resolved from the WE repo root against the
 * sibling `../frontierui` checkout, no PATH lookup. FUI's `npm run build:tools` esbuild-bundles the CLI
 * to exactly this self-contained ESM file.
 *
 * In a lane clone the sibling `../frontierui` does not exist. Set `WE_FUI_ROOT` to the absolute path of
 * the primary FUI checkout (read-only artifact reference) to override the default sibling resolution
 * (#2178 lane isolation fix). The primary checkout still works with no env-var set.
 */
/** Path to the pinned CLI artifact WITHIN the FUI root — single source of truth for the suffix.
 *  `runBuildBatch` joins it onto `resolveFuiRoot(repoRoot)`; tests use it via `PINNED_CLI_RELATIVE`. */
const FUI_CLI_RELATIVE = path.join('dist', 'tools', 'component-render', 'cli.mjs');

/** Full path relative to the WE repo root (the classic sibling layout) — EXPORTED for tests that
 *  construct a stub artifact at this location. Derived from `FUI_CLI_RELATIVE` so both stay in sync. */
const PINNED_CLI_RELATIVE = path.join('..', 'frontierui', FUI_CLI_RELATIVE);

/**
 * Resolve the FUI root directory: `WE_FUI_ROOT` env-var (absolute, for lane clones, #2178) takes
 * precedence; otherwise the default sibling `../frontierui` relative to `repoRoot` is used (primary
 * checkout). This is the ONLY place the FUI root path is resolved — keeping the knob in one spot.
 * @param {string} repoRoot - WE repo root (absolute path, typically `__dirname` from .eleventy.js)
 * @returns {string} absolute path to the FUI root directory
 */
function resolveFuiRoot(repoRoot) {
  const override = process.env.WE_FUI_ROOT;
  if (override) return path.resolve(override);
  return path.resolve(repoRoot, '..', 'frontierui');
}

/** Producer pin the FUI harness stamps onto its batch envelope — surfaced so a stale artifact is visible.
 *  Kept in sync with `frontierui/blocks/renderers/component-render/buildHarness.ts:BUILD_HARNESS_PRODUCER`. */
const EXPECTED_PRODUCER = 'frontierui/component-render-build-harness/1';

/**
 * Shell out to the pinned FUI build-CLI: keyed-batch JSON on stdin, keyed-batch envelope on stdout.
 * `repoRoot` is the WE repo root the fixed relative artifact path is resolved against. Throws a hard
 * build error when the artifact is absent (the ratified ordering means FUI built it first) or the process
 * fails — a missing/mis-emitted artifact must NOT silently skip (non-reproducible build).
 */
function runBuildBatch(entries, repoRoot, runner = runCliToFile) {
  const cliPath = path.join(resolveFuiRoot(repoRoot), FUI_CLI_RELATIVE);
  if (!fs.existsSync(cliPath)) {
    throw new Error(
      `[component-render build] pinned FUI artifact missing at ${cliPath} — run FUI \`npm run build:tools\` `
      + `before WE \`build:docs\` (ratified ordering, #1946/#2016). A missing artifact is a hard build error.`,
    );
  }
  const input = JSON.stringify(entries);
  const out = runner('node', [cliPath], { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  let batch;
  try {
    batch = JSON.parse(out);
  } catch (e) {
    throw new Error(`[component-render build] CLI returned non-JSON output: ${e && e.message}`);
  }
  if (!batch || batch.producer !== EXPECTED_PRODUCER) {
    throw new Error(
      `[component-render build] producer pin mismatch (got ${batch && batch.producer}, expected `
      + `${EXPECTED_PRODUCER}) — the pinned artifact is stale or PATH-resolved.`,
    );
  }
  return batch;
}

/**
 * Render a keyed batch of component specs to a `{ key -> html }` map in one subprocess call. Each spec is
 * `{ key, component: 'card'|'badge'|'tag', config }`. A per-entry error is surfaced to the build log and
 * that key is omitted from the map (keyed-batch isolation — one bad spec never poisons the others).
 */
function renderComponents(specs, repoRoot, runner = runCliToFile) {
  if (!Array.isArray(specs) || specs.length === 0) return new Map();
  let batch;
  try {
    batch = runBuildBatch(specs, repoRoot, runner);
  } catch (e) {
    // The whole-site batch's stdout can outgrow the subprocess `maxBuffer` as the site grows (red main @
    // f5aa5b111: `spawnSync node ENOBUFS` in the deploy-smoke docs build). Halve the batch and retry rather
    // than chase a bigger constant; keys are globally unique so the halves merge losslessly. A single spec
    // that overflows alone (or any other failure) is still a hard error.
    if (!(e && e.code === 'ENOBUFS') || specs.length < 2) throw e;
    const mid = Math.ceil(specs.length / 2);
    const merged = renderComponents(specs.slice(0, mid), repoRoot, runner);
    for (const [k, v] of renderComponents(specs.slice(mid), repoRoot, runner)) merged.set(k, v);
    return merged;
  }
  const byKey = new Map();
  for (const res of batch.results) {
    if (!res || res.error || !res.html) {
      if (res && res.error) {
        // eslint-disable-next-line no-console
        console.warn(`[component-render build] spec "${res && res.key}" failed, omitted: ${res.error}`);
      }
      continue;
    }
    byKey.set(res.key, res.html);
  }
  return byKey;
}

/**
 * Portfolio-tier vocabulary (#2088 Fork 4 / #2133) — the importance axis orthogonal to `status`. The tier
 * renders as a categorical `<we-tag>` cue (`set="project-tier"`) per the by-intent statute; `we-badge`
 * stays the status pill. The ORDER here is the SSR grouping order the grids sort by (core → contextual →
 * exploratory, statute #portfolio-project-tiering) and the palette is homed in `src/css/style.css`.
 * `TIER_RANK` sorts unknown/absent tiers last (they never precede a stamped one).
 */
const TIER_ORDER = ['core', 'contextual', 'exploratory'];
const TIER_LABEL = { core: 'Core', contextual: 'Contextual', exploratory: 'Exploratory' };
function tierRank(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return i === -1 ? TIER_ORDER.length : i;
}
/** A tier's `<we-tag>` spec (categorical `(set,value)` mode — the docs palette paints it, #1670/#1682).
 *  Returns null for an absent/unknown tier so a not-yet-stamped project simply carries no cue. */
function tierTagConfig(tier) {
  if (!tier || !TIER_LABEL[tier]) return null;
  return {
    label: TIER_LABEL[tier], set: 'project-tier', value: tier,
    shape: 'pill', className: 'project-tier-tag',
  };
}

/** Map an intent status to its badge tone (mirrors the prior template ternary in `src/intents.njk`). */
function statusTone(status) {
  if (status === 'active' || status === 'stable') return 'success';
  if (status === 'draft') return 'info';
  if (status === 'poc') return 'info';
  if (status === 'concept' || status === 'experimental') return 'warning';
  return 'neutral';
}

/** Uppercase-first (the `| title` the template applied to the status label). */
function titleCase(s) {
  return typeof s === 'string' && s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Minimal HTML-attribute escaper for values spliced into the grid wrapper markup. */
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The dimension keys of an intent (its `dimensions` object keys), in declared order. */
function dimensionKeys(intent) {
  const dims = intent && intent.dimensions;
  return dims && typeof dims === 'object' ? Object.keys(dims) : [];
}

/**
 * Build the keyed component specs for one intent tile: a status `badge`, one `tag` per dimension, and the
 * `card` shell whose body composes the summary + tag row and whose header actions carry the badge. The
 * card body/actions reference the sibling specs by key — the caller resolves them AFTER the batch renders
 * (a card spec's `actionsHtml`/`body` need the rendered badge/tag HTML), so this returns the leaf specs
 * (badge + tags) to render in the batch plus a `compose(rendered)` that assembles the card spec.
 */
function intentTileSpecs(intent, i) {
  const badgeKey = `intent-${i}-badge`;
  const dimKeys = dimensionKeys(intent);
  const tagSpecs = dimKeys.map((key, j) => ({
    key: `intent-${i}-tag-${j}`,
    component: 'tag',
    config: { label: key, shape: 'pill', className: 'intent-dim-tag' },
  }));
  const leaves = [
    { key: badgeKey, component: 'badge', config: { label: titleCase(intent.status), tone: statusTone(intent.status) } },
    ...tagSpecs,
  ];
  return { leaves, badgeKey, tagKeys: tagSpecs.map((t) => t.key) };
}

/**
 * Render the full intents catalog grid to SSR HTML in ONE subprocess batch (#2016 acceptance surface).
 * Two-pass over the batch: (1) render every tile's leaf badge + tags; (2) render each tile's card shell,
 * feeding the already-rendered badge as the header `actionsHtml` and the summary + tag row as the body.
 * Returns the `<div class="project-grid">…</div>` markup ready to splice into `src/intents.njk`.
 *
 * The outer `<a class="project-card intent-tile">` linking wrapper + the search/filter `data-*` are kept
 * in the template (they are page chrome, not the card block); this only emits the SSR card frame each
 * anchor wraps — the same division of labour the prior `<we-card>`-in-template markup had.
 */
function renderIntentGrid(intents, repoRoot, runner = runCliToFile) {
  const list = Array.isArray(intents) ? intents : [];

  // Pass 1 — batch every tile's leaf badge + tags in a single subprocess call.
  const tiles = list.map((intent, i) => intentTileSpecs(intent, i));
  const leafSpecs = tiles.flatMap((t) => t.leaves);
  const leaves = renderComponents(leafSpecs, repoRoot, runner);

  // Pass 2 — batch every tile's card shell, fed the pass-1 badge/tag HTML. The body is an escape-safe
  // PARTS list: the summary is TEXT (set via textContent downstream, so a literal `<title>` in a summary
  // can't inject a tag), the dimension-chip row is trusted HTML (the pre-serialized `.fui-tag` spans).
  const cardSpecs = list.map((intent, i) => {
    const t = tiles[i];
    const badgeHtml = leaves.get(t.badgeKey) || '';
    const tagHtml = t.tagKeys.map((k) => leaves.get(k) || '').join('');
    const bodyParts = [{ tag: 'p', className: 'intent-summary', text: String(intent.summary || '') }];
    if (tagHtml) bodyParts.push({ tag: 'div', className: 'intent-dim-row', html: tagHtml });
    return {
      key: `intent-${i}-card`,
      component: 'card',
      config: {
        title: intent.name,
        actionsHtml: badgeHtml,
        bodyParts,
        className: 'intent-card',
      },
    };
  });
  const cards = renderComponents(cardSpecs, repoRoot, runner);

  // Assemble the grid: each card frame is a `.project-card` BOX with a `.project-card-link` overlay anchor
  // (not an <a> wrapping the card) + the search/filter `data-*` on the box. See renderProjectGrid for why the
  // wrapping anchor is invalid — the card body carries authored inline `<a>` links, and nested anchors make
  // the parser clone empty ghost tiles. The `data-status`/`data-haystack` facets stay on `.project-card` so
  // the client filter (which queries `.project-card`) is unaffected.
  const wrappers = list.map((intent, i) => {
    const cardHtml = cards.get(`intent-${i}-card`) || '';
    const dimKeys = dimensionKeys(intent);
    const haystack = `${intent.id} ${String(intent.name || '').toLowerCase()} `
      + `${String(intent.summary || '').toLowerCase()} ${dimKeys.join(' ').toLowerCase()}`;
    return (
      `<div class="project-card intent-tile" `
      + `data-status="${escapeAttr(intent.status)}" data-haystack="${escapeAttr(haystack)}">`
      + `<a href="/intents/${escapeAttr(intent.id)}/" class="project-card-link" `
      + `aria-label="View ${escapeAttr(intent.name)}"></a>`
      + `${cardHtml}</div>`
    );
  });

  return `<div class="project-grid" id="intent-grid">${wrappers.join('')}</div>`;
}

/**
 * Render one project's icon block as trusted HTML (leading body row). `isSvg` projects carry an
 * `<img>` path; the emoji/text projects carry a literal glyph. Mirrors the `.project-icon` markup the
 * prior hand-rolled `.project-card` template emitted.
 */
function projectIconHtml(project) {
  if (project && project.isSvg) {
    const src = escapeAttr(project.icon);
    const alt = escapeAttr(`${project.name || ''} icon`);
    return `<img src="${src}" alt="${alt}" width="48" height="48">`;
  }
  // Trusted literal glyph (emoji or short text from our own project data).
  return String(project && project.icon != null ? project.icon : '');
}

/**
 * The card-header variant of the project icon: decorative (the sibling title already names the project,
 * so `alt=""` and the wrapping span is `aria-hidden`) and sized down for the header row.
 */
function projectHeaderIconHtml(project) {
  if (project && project.isSvg) {
    const src = escapeAttr(project.icon);
    return `<img src="${src}" alt="" width="28" height="28">`;
  }
  return String(project && project.icon != null ? project.icon : '');
}

/**
 * Render the home/index project grid to SSR HTML in ONE subprocess batch (#2019, generalizing the
 * #2016 `renderIntentGrid` pattern from the intents catalog to the landing page). Each project becomes a
 * `we-card` SSR tile: the name is the card title, the status is a header-trailing `we-badge` (render-from-
 * data), and the body carries the icon + description + the existing status-meter progress bar. The outer
 * click-through `<a class="project-card">` linking wrapper stays page chrome (same division of labour as
 * `renderIntentGrid`); the anchor's own frame is stripped by `.project-card:has(> .fui-card)` in
 * `style.css`, so the card is the sole visual frame.
 *
 * `projects` is the list to render; `hrefFor(project)` returns the tile's link target (the landing page
 * links standard/protocol tiles to `/projects/{id}/` but the impls tile to an external URL, so the caller
 * supplies it). `gridClass` is the wrapping grid's class list (e.g. `project-grid project-grid--centered`).
 */
function renderProjectGrid(projects, { repoRoot, hrefFor, gridClass = 'project-grid', external = false }, runner = runCliToFile) {
  const input = Array.isArray(projects) ? projects : [];
  // SSR default grouping (#2088 Fork 4 / #2133): stable-sort the tiles core → contextual → exploratory so
  // the grid GROUPS by importance out of the box (client re-sortable via the `data-tier` facet below). A
  // stable sort keeps the authored within-tier order; projects with no/unknown tier sort last (tierRank).
  const list = input
    .map((project, order) => ({ project, order }))
    .sort((a, b) => (tierRank(a.project.tier) - tierRank(b.project.tier)) || (a.order - b.order))
    .map((e) => e.project);

  // Pass 1 — batch every tile's status badge AND its portfolio-tier tag in one subprocess call. The badge is
  // the STATUS pill (maturity axis); the tag is the TIER cue (importance axis) — orthogonal, they render
  // side by side in the card header per the by-intent statute (`we-badge` status, `we-tag` classification).
  const badgeSpecs = list.map((project, i) => ({
    key: `project-${i}-badge`,
    component: 'badge',
    config: { label: titleCase(project.status), tone: statusTone(project.status) },
  }));
  const tierSpecs = list.flatMap((project, i) => {
    const cfg = tierTagConfig(project.tier);
    return cfg ? [{ key: `project-${i}-tier`, component: 'tag', config: cfg }] : [];
  });
  const rendered = renderComponents([...badgeSpecs, ...tierSpecs], repoRoot, runner);
  const badges = rendered;
  const tierTags = rendered;

  // Pass 2 — batch every tile's card shell, fed the pass-1 badge as the header actions. The icon row +
  // status-meter row are our own generated markup (safe through the harness `html:` innerHTML round-trip).
  //
  // The DESCRIPTION is SENTINEL-spliced, NOT a `html:` body part (the same fix renderBacklogGrid uses, #2168):
  // an authored description mixes render-me markup (`<strong>`/`<code>`/`<a>`) with PRE-ESCAPED code examples
  // (e.g. `&lt;template route="…"&gt;`). Feeding it through the harness's `html:` part sets it via `innerHTML=`,
  // which happy-dom DECODES, and the `.outerHTML` serializer re-emits a raw `<template>` — a live tag that
  // absorbs the rest of the page into an inert fragment (home rendered only 1 of its 3 grids). So the card
  // shell gets a unique sentinel, and the trusted, already-escaped description is string-spliced in verbatim
  // (bypassing the innerHTML round-trip), exactly as the `| safe` template output did pre-#2019.
  // The card body shows a SHORT authored `summary` (one plain-text sentence per project, in the
  // `src/_data/projects/<id>.json` entry), NOT the full `description` — the descriptions run 76→1700+
  // chars, wildly uneven as tiles; the full prose lives on each project's own `/projects/{id}/` page.
  // Summary is plain authored text, sentinel-spliced verbatim like the description was (bypassing the
  // harness innerHTML round-trip); older entries with no summary fall back to the description.
  const descSentinel = (i) => ` PROJECT_DESC_${i} `;
  const cardSpecs = list.map((project, i) => {
    // Header actions carry the status badge, then the tier tag (when the project is stamped) — orthogonal
    // axes side by side. Both are already-serialized `.fui-badge`/`.fui-tag` spans, safe as header HTML.
    const badgeHtml = (badges.get(`project-${i}-badge`) || '') + (tierTags.get(`project-${i}-tier`) || '');
    const meterHtml =
      `<div class="status-meter status-${escapeAttr(project.status)}">`
      + `<span class="status-label">Status: ${escapeAttr(titleCase(project.status))}</span>`
      + `<div class="meter-track"><div class="meter-fill"></div></div></div>`;
    // The icon moves into the card HEADER (spliced before the title below) instead of leading the body.
    const bodyParts = [
      { tag: 'p', className: 'project-desc', html: descSentinel(i) },
      { tag: 'div', className: 'project-status-row', html: meterHtml },
    ];
    return {
      key: `project-${i}-card`,
      component: 'card',
      config: {
        title: project.name,
        actionsHtml: badgeHtml,
        bodyParts,
        className: 'project-tile-card',
      },
    };
  });
  const cards = renderComponents(cardSpecs, repoRoot, runner);

  // Assemble the grid: each card frame is a `.project-card` BOX with a `.project-card-link` overlay anchor
  // (position:absolute; inset:0) for whole-tile click-through — NOT an <a> wrapping the card. The card body
  // carries authored inline links (`<a>` in the description), and an <a> may not contain another <a>: an
  // outer wrapping anchor makes that nesting, which the browser's adoption-agency parser "repairs" by
  // splitting the tile and cloning an EMPTY `.project-card` after every inner link (47 tiles → 71 in the DOM,
  // ~24 empty ghosts — invisible in source, only in the rendered DOM). Overlay-link is the valid, backlog-grid
  // pattern; `.project-card:has(> .fui-card)` still matches (the fui-card stays a direct child).
  const wrappers = list.map((project, i) => {
    // Splice the verbatim summary (fallback: description) over its sentinel — never through the harness's
    // innerHTML round-trip, which would decode pre-escaped `&lt;template&gt;`/`&lt;script&gt;` into live tags (#2168).
    const blurb = project.summary || project.description || '';
    // Splice the icon into the card header, before the title. It's decorative here (the title names the
    // project), so it carries no accessible name — added as a leading `.project-icon--header` span.
    const cardHtml = (cards.get(`project-${i}-card`) || '')
      .replace(descSentinel(i), String(blurb))
      .replace(
        '<h3 class="fui-card__title"',
        `<span class="project-icon--header" aria-hidden="true">${projectHeaderIconHtml(project)}</span><h3 class="fui-card__title"`,
      );
    const rel = external ? ' target="_blank" rel="noopener"' : '';
    // `data-tier` is the client re-sort/filter facet (home-display.js reads it) — the SSR default is the
    // grouped order above; the tier is also what the client would key a re-sort off. Omitted when absent.
    const tierAttr = project.tier ? ` data-tier="${escapeAttr(project.tier)}"` : '';
    return (
      `<div class="project-card"${tierAttr}>`
      + `<a href="${escapeAttr(hrefFor(project))}" class="project-card-link" `
      + `aria-label="View ${escapeAttr(project.name)}"${rel}></a>`
      + `${cardHtml}</div>`
    );
  });

  return `<div class="${escapeAttr(gridClass)}">${wrappers.join('')}</div>`;
}

/**
 * Render the governance lifecycle stage grid to SSR HTML in ONE subprocess batch (#2020, generalizing the
 * #2016 SSR path to the governance page). Each stage becomes a `we-card` SSR tile: the `N · Name` line is
 * the card title, the stage marker (`We are here` / the future-gate label) is a header-trailing `we-badge`
 * (render-from-data per #2007 — the current stage takes the `info` tone, the future stages `neutral`), and
 * the body carries the role line + description + the "moves on when" gate. There is NO outer linking anchor
 * (stage cards are not click-throughs — unlike the intent/project grids), so the `.fui-card` is spliced
 * straight into the grid. The current stage's card gets a `.stage-tile-card--current` class so the accent
 * border (`src/css/style.css`) can key off it, replacing the retired `.stage-card.is-current` rule.
 *
 * `stages` is the list of `{ n, name, tag, current, role, description, gate }` — `role`/`description`/`gate`
 * carry trusted authored HTML (our own template data with `<strong>` emphasis), spliced via body `html`
 * parts. The client `<we-card>`/`<we-badge>` CE upgrade (base.njk) is a pure enhancement over this
 * JS-off-correct baseline.
 */
function renderStageGrid(stages, repoRoot, runner = runCliToFile) {
  const list = Array.isArray(stages) ? stages : [];

  // Pass 1 — batch every stage's marker badge in one subprocess call.
  const badgeSpecs = list.map((stage, i) => ({
    key: `stage-${i}-badge`,
    component: 'badge',
    config: { label: String(stage.tag || ''), tone: stage.current ? 'info' : 'neutral' },
  }));
  const badges = renderComponents(badgeSpecs, repoRoot, runner);

  // Pass 2 — batch every stage's card shell, fed the pass-1 badge as the header actions. The body parts are
  // TRUSTED authored HTML (our own governance copy carrying `<strong>` emphasis), not user input.
  const cardSpecs = list.map((stage, i) => {
    const badgeHtml = badges.get(`stage-${i}-badge`) || '';
    const bodyParts = [
      { tag: 'p', className: 'stage-role', html: String(stage.role || '') },
      { tag: 'p', className: 'stage-desc', html: String(stage.description || '') },
      { tag: 'p', className: 'stage-gate', html: String(stage.gate || '') },
    ];
    return {
      key: `stage-${i}-card`,
      component: 'card',
      config: {
        title: `${stage.n} · ${stage.name}`,
        actionsHtml: badgeHtml,
        bodyParts,
        className: stage.current ? 'stage-tile-card stage-tile-card--current' : 'stage-tile-card',
      },
    };
  });
  const cards = renderComponents(cardSpecs, repoRoot, runner);

  const tiles = list.map((stage, i) => cards.get(`stage-${i}-card`) || '');
  return `<div class="gov-stages">${tiles.join('')}</div>`;
}

/**
 * Render the backlog tracked-work tile grid to SSR HTML in ONE subprocess batch (#2018, generalizing the
 * #2016 SSR path to the biggest hand-rolled surface on the site — the /backlog/ item grid). Each item
 * becomes a `we-card` SSR tile: the `#num Title` line is the card title, and the whole tile body (the
 * badge/tag row, blockers, summary, epic-children circles, and meta links) is fed as ONE trusted
 * pre-serialized HTML part.
 *
 * WHY the body arrives pre-rendered (unlike the intent/project/stage grids, which compose their leaf
 * badge/tag specs here): the backlog tile's badges come from the SHARED `src/_includes/backlog-badges.njk`
 * macros (`kindBadge`/`statusBadge`/`sizeBadge`/`tierBadge`/`epicStatusBadge`/`reasonPill`/`blockerChip`/
 * `childCircle`/`tagsRow`), the single anti-drift source of truth whose rich vocabulary (tones, tooltips,
 * per-reason palettes) lives in Nunjucks + `backlogMeta.js` and MUST NOT be re-implemented here
 * (`check:standards` forbids re-defining those macros). So the template captures each tile's inner HTML via
 * those macros and hands it in; this hook only renders the SSR **card shell** around it (render-from-data
 * per #2007 — the card owns its header/body/footer shape). The badge/tag children stay transient-CE and
 * upgrade as a pure enhancement over the SSR-correct baseline.
 *
 * `tiles` is a list of `{ id, num, title, status, kind, size, tier, innerHtml }`. The outer click-through
 * `.project-card` wrapper (grid layout + the `data-status/kind/size/tier` filter facets + the
 * `.project-card-link` overlay anchor) stays page chrome — the same division of labour as the other grids;
 * `style.css` `.project-card:has(> .fui-card)` strips the wrapper's own frame so the card is the sole box.
 * A `.project-title` alias class on the SSR title keeps the client search filter (`home-display.js`, which
 * reads `.project-title` + the first `<p>`) working unchanged over the new markup.
 *
 * WHY the body is SENTINEL-spliced, not fed as a `html:` body part: the macro-captured `innerHtml` is
 * already correctly entity-escaped by Nunjucks (a summary like `materialized onto <template>` arrives as
 * `&lt;template&gt;`). Feeding it through the harness's `html:` part sets it via `innerHTML=`, which DECODES
 * those entities, and happy-dom's `.outerHTML` serializer then re-emits the raw `<template>` — a leaked tag
 * that swallows the rest of the grid into a template fragment (the DOM-truncation bug). So the card SHELL is
 * rendered with a unique sentinel body, and the trusted macro HTML is string-spliced into it verbatim —
 * bypassing the happy-dom body round-trip entirely, so the escaping the template already did is preserved.
 */
function renderBacklogGrid(tiles, repoRoot, runner = runCliToFile) {
  const list = Array.isArray(tiles) ? tiles : [];

  // ONE subprocess batch: every tile's card SHELL, with a unique sentinel standing in for its body. The
  // trusted, already-escaped macro HTML is spliced over the sentinel below (never through happy-dom's
  // innerHTML round-trip). `#num` is folded into the title text (plain) so search + view-source read it.
  const sentinel = (i) => ` BACKLOG_BODY_${i} `;
  const cardSpecs = list.map((t, i) => {
    const num = t.num != null && t.num !== '' ? `#${t.num} ` : '';
    return {
      key: `backlog-${i}-card`,
      component: 'card',
      config: {
        title: `${num}${t.title || ''}`,
        bodyParts: [{ tag: 'div', className: 'backlog-tile-body', html: sentinel(i) }],
        className: 'backlog-tile-card',
      },
    };
  });
  const cards = renderComponents(cardSpecs, repoRoot, runner);

  // Assemble the grid: each SSR card frame wrapped in its `.project-card` filter/link chrome. The title
  // carries a `.project-title` alias (added post-render) so the existing search filter still finds it, and
  // the sentinel body is replaced by the verbatim trusted macro HTML.
  const wrappers = list.map((t, i) => {
    const cardHtml = (cards.get(`backlog-${i}-card`) || '')
      .replace('class="fui-card__title"', 'class="fui-card__title project-title"')
      .replace(sentinel(i), String(t.innerHtml || ''));
    const data =
      `data-status="${escapeAttr(t.status)}" data-kind="${escapeAttr(t.kind)}" `
      + `data-size="${escapeAttr(t.size == null ? '' : t.size)}" data-tier="${escapeAttr(t.tier == null ? '' : t.tier)}"`;
    return (
      `<div class="project-card" ${data}>`
      + `<a href="/backlog/${escapeAttr(t.id)}/" class="project-card-link" aria-label="View ${escapeAttr(t.title)}"></a>`
      + `${cardHtml}</div>`
    );
  });

  return `<div class="project-grid">${wrappers.join('')}</div>`;
}

// ── Generic template-facing card/badge primitive (#2098) ─────────────────────────────────────────────
//
// The grid renderers above (`renderIntentGrid`/`renderProjectGrid`/…) are DATA-driven: a single shortcode
// consumes a whole collection and emits the finished grid in one synchronous call. That covers the
// catalog surfaces #2016 built, but leaves the one-off case the templates actually reach for uncovered:
// an author who wants a SINGLE SSR card or badge inline in prose (e.g. the `section-card` in
// `src/semantics.njk`). A naive per-card shortcode that shells to the FUI CLI on the spot would spawn one
// subprocess PER card — ~800 per full build. So the generic primitive is split, mirroring the
// `spliceDataTables` transform precedent (`data-table-build-hook.cjs`, wired at `.eleventy.js:275-278`):
//
//   1. The `weCard` / `weBadge` Nunjucks macros (`src/_includes/we-component.njk`) emit an INERT
//      placeholder — `<we-card data-we-spec='{…}'>…SSR-fallback…</we-card>` — carrying the declarative
//      spec as a JSON attribute (render-from-data per #2007: the macro feeds inert DATA, it does NOT
//      author the card's internal markup). With JS off and no build transform the placeholder still paints
//      via the `we-card{}` / `we-badge{}` SSR baseline in `style.css` (the same baseline the transient CE
//      upgrades over), so the primitive degrades safely even mid-build.
//   2. `spliceComponents` (this transform body, wired as the `weComponentSSR` Eleventy transform) scans
//      ONE rendered page for every `data-we-spec` placeholder, resolves each to a `{component, config}`
//      spec, batches ALL of the page's specs through `renderComponents` in a SINGLE subprocess call, and
//      splices each returned SSR fragment in place of its placeholder element. One subprocess per PAGE, not
//      per card.
//   3. The client `<we-card>` / `<we-badge>` CE upgrade (`src/_layouts/base.njk`) is a pure enhancement
//      over the spliced SSR: the emitted HTML is byte-identical to what the transient element upgrades to
//      (same FUI factory feeds both paths), so there is nothing to re-upgrade — idempotent by construction,
//      JS-off correct.
//
// A page with no `data-we-spec` placeholder pays a single substring check and returns unchanged.

/** The generic component-placeholder scanner: a `<we-card|we-badge … data-we-spec='…'>…</…>` element (or
 *  its self-closing form). Captures the tag name, the whole open-tag attribute string, and the body so the
 *  element can be replaced wholesale by its SSR fragment. The attribute matcher is QUOTE-AWARE — the
 *  `data-we-spec` JSON value legally carries literal `>`/`<` (nested markup inside its string values), so a
 *  naive `[^>]*` would terminate the open tag early; instead each attribute chunk is either a quoted region
 *  (which may contain `>`) or a run of non-`>`/non-quote characters. `we-card`/`we-badge`/`we-tag` carrying
 *  a `data-we-spec` are batched here; a bare `<we-tag set value>` (the backlog taxonomy pills, no
 *  `data-we-spec`) is left to its runtime CE path, and `we-data-table` keeps its own data-driven path. */
const ATTRS = `(?:"[^"]*"|'[^']*'|[^>"'])*?`;
const COMPONENT_TAG = new RegExp(`<we-(card|badge|tag)\\b(${ATTRS})>([\\s\\S]*?)<\\/we-\\1>`, 'gi');
const COMPONENT_SELF_CLOSING = new RegExp(`<we-(card|badge|tag)\\b(${ATTRS})\\/>`, 'gi');

/** Read the `data-we-spec` attribute off an open-tag attribute string, tolerating single OR double quotes
 *  (Nunjucks emits the JSON single-quoted so the double-quoted JSON string keys need no entity-escaping).
 *  Returns the raw attribute value or undefined. */
function readSpecAttr(attrs) {
  const dq = /\bdata-we-spec\s*=\s*"([\s\S]*?)"/i.exec(attrs);
  if (dq) return dq[1];
  const sq = /\bdata-we-spec\s*=\s*'([\s\S]*?)'/i.exec(attrs);
  return sq ? sq[1] : undefined;
}

/** Reverse the single escape the `weSpecAttr` macro applied so `JSON.parse` sees clean JSON. The spec is
 *  carried in a SINGLE-quoted attribute, so its own `"` keys are already valid and a bare `&` is legal —
 *  the macro escapes ONLY a literal `'` (which would otherwise close the attribute) as `&#39;`, so this
 *  reverses exactly that (plus `&apos;` for a double-quoted authoring). Nothing else is touched, so an
 *  `&amp;`/`&lt;` that is genuinely part of a spec string value survives verbatim (no double-decode). */
function decodeSpecEntities(raw) {
  return String(raw).replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}

/**
 * Detect every generic component placeholder in one page's HTML. Returns an array of
 * `{ key, component, config, match }` — one per `<we-card|we-badge data-we-spec='…'>` whose spec parses to
 * a `{component, config}` (or a bare `config` under the tag's component). A placeholder with no
 * `data-we-spec`, or an unparseable spec, is SKIPPED (left intact for the client CE runtime path) — a
 * malformed inline spec must never abort the page build.
 */
function findComponentPlaceholders(html) {
  const found = [];
  let key = 0;
  const collect = (tag, attrs, match) => {
    const raw = readSpecAttr(attrs);
    if (raw == null) return; // no declarative spec — client CE path owns it
    let spec;
    try {
      spec = JSON.parse(decodeSpecEntities(raw));
    } catch {
      return; // malformed spec — leave intact, never abort the build
    }
    if (!spec || typeof spec !== 'object') return;
    // Accept either `{component, config}` or a bare config object (component inferred from the tag name).
    const component = typeof spec.component === 'string' ? spec.component : tag;
    if (component !== 'card' && component !== 'badge' && component !== 'tag') return; // the generic primitives
    const config = spec.config && typeof spec.config === 'object'
      ? spec.config
      : (spec.component ? {} : spec);
    found.push({ key: `we-component-${key++}`, component, config, match });
  };
  let mm;
  COMPONENT_TAG.lastIndex = 0;
  while ((mm = COMPONENT_TAG.exec(html)) !== null) collect(mm[1], mm[2], mm[0]);
  COMPONENT_SELF_CLOSING.lastIndex = 0;
  while ((mm = COMPONENT_SELF_CLOSING.exec(html)) !== null) collect(mm[1], mm[2], mm[0]);
  return found;
}

/**
 * The `weComponentSSR` Eleventy transform body (#2098): batch every generic `<we-card|we-badge
 * data-we-spec>` placeholder on one page through the pinned FUI CLI in ONE subprocess call and splice each
 * returned SSR fragment in place of its placeholder. Returns `content` unchanged when the page carries no
 * placeholder (a single substring check — the common case pays nothing). Per-entry errors are isolated:
 * a failed spec leaves its original placeholder intact (the client CE + `style.css` SSR baseline still
 * paint it) and is logged, never aborting the page (keyed-batch isolation).
 *
 * WHY this and not a per-card shortcode: a per-card shortcode that shelled the FUI CLI would spawn ~800
 * subprocesses per full build; this batches a whole page's cards/badges into one — the same subprocess
 * economy the `spliceDataTables` transform gives the data-table surface.
 */
function spliceComponents(content, repoRoot, runner = runCliToFile) {
  if (typeof content !== 'string' || content.indexOf('data-we-spec') === -1) return content;
  const placeholders = findComponentPlaceholders(content);
  if (placeholders.length === 0) return content;

  const rendered = renderComponents(
    placeholders.map((p) => ({ key: p.key, component: p.component, config: p.config })),
    repoRoot,
    runner,
  );

  let out = content;
  for (const p of placeholders) {
    const html = rendered.get(p.key);
    if (!html) continue; // isolated failure already logged by renderComponents — keep the placeholder
    // Splice the finished SSR fragment for the WHOLE placeholder element: the returned `<article
    // class="fui-card">` / `<span class="fui-badge">` is byte-identical to the client CE upgrade, so the
    // element it replaces need not survive — nothing left to re-upgrade (idempotent).
    out = out.replace(p.match, html);
  }
  return out;
}

/**
 * Build-level generalization of {@link spliceComponents} (#2185) — splice EVERY generic `<we-card|we-badge|
 * we-tag data-we-spec>` placeholder across the WHOLE written site in ONE subprocess call, instead of one
 * cold `node` spawn per page.
 *
 * WHY: the former `weComponentSSR` per-page transform paid a full `node`+happy-dom cold start (~0.2–0.4s)
 * on every page carrying a placeholder. The backlog dogfood (#2102) put 4 `weCard` placeholders on all
 * ~2167 backlog item pages, so a cold `build:docs` serially spawned ~2167 subprocesses (~16 min) — long
 * enough that the 11ty dev server never bound its port in a usable time and the Vite `/backlog/…` proxy
 * ECONNREFUSED'd the whole window. Batching every page's placeholders into a single keyed subprocess pays
 * the cold start ONCE; output is byte-identical (the placeholder's `data-we-spec` is self-describing, so
 * re-extracting + splicing post-write yields the same SSR fragment the per-page transform produced).
 *
 * Driven off the `eleventy.after` event's `results` (each `{ outputPath, content }` — the final written
 * page). In `--serve` incremental rebuilds `results` is just the changed pages, so a dev edit re-splices
 * only what it touched. Pages/passthrough with no `data-we-spec` pay a single substring check. The spliced
 * content is written back over the already-written file (files are on disk before the after event fires,
 * and the dev-server reload is triggered only after the build — incl. this event — completes).
 *
 * Same subprocess boundary + pinned-artifact/missing-artifact hard error + keyed-batch per-entry isolation
 * as the per-page path. Returns `{ pages, components }` for the caller to log.
 */
function spliceComponentsBatch(results, repoRoot, runner = runCliToFile, writeFile = fs.writeFileSync) {
  if (!Array.isArray(results) || results.length === 0) return { pages: 0, components: 0 };

  // Pass 1 — collect every placeholder across every written HTML page into ONE globally-keyed batch.
  const perPage = []; // { outputPath, content, spliced: [{ globalKey, match }] }
  const specs = [];
  let gk = 0;
  for (const r of results) {
    const outputPath = r && r.outputPath;
    const content = r && r.content;
    if (typeof outputPath !== 'string' || !/\.html?$/.test(outputPath)) continue;
    if (typeof content !== 'string' || content.indexOf('data-we-spec') === -1) continue;
    const placeholders = findComponentPlaceholders(content);
    if (placeholders.length === 0) continue;
    const spliced = placeholders.map((p) => {
      const globalKey = `we-c-${gk++}`;
      specs.push({ key: globalKey, component: p.component, config: p.config });
      return { globalKey, match: p.match };
    });
    perPage.push({ outputPath, content, spliced });
  }
  if (specs.length === 0) return { pages: 0, components: 0 };

  // ONE subprocess for the entire site (keyed-batch in / keyed-batch out).
  const rendered = renderComponents(specs, repoRoot, runner);

  // Pass 2 — splice each page's placeholders and write the finished page back over itself. A per-entry
  // failure (no rendered HTML for its key) leaves that placeholder intact for the client CE path.
  let pages = 0;
  for (const page of perPage) {
    let out = page.content;
    let changed = false;
    for (const p of page.spliced) {
      const html = rendered.get(p.globalKey);
      if (!html) continue; // isolated failure already logged by renderComponents — keep the placeholder
      // Match `spliceComponents` exactly: replace the whole placeholder element with its SSR fragment.
      // A function replacer avoids `$`-pattern interpretation in the rendered HTML.
      out = out.replace(p.match, () => html);
      changed = true;
    }
    if (changed) {
      writeFile(page.outputPath, out);
      pages++;
    }
  }
  return { pages, components: specs.length };
}

module.exports = {
  FUI_CLI_RELATIVE,
  PINNED_CLI_RELATIVE,
  resolveFuiRoot,
  EXPECTED_PRODUCER,
  runBuildBatch,
  renderComponents,
  renderIntentGrid,
  renderProjectGrid,
  renderStageGrid,
  renderBacklogGrid,
  projectIconHtml,
  statusTone,
  tierTagConfig,
  tierRank,
  TIER_ORDER,
  intentTileSpecs,
  findComponentPlaceholders,
  spliceComponents,
  spliceComponentsBatch,
};
