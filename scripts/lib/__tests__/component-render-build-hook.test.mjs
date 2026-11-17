/**
 * component-render-build-hook — the WE Eleventy build orchestration for the SSR component-render harness
 * (#2016, keystone of #777). Proves the render-from-data arc on a build fixture: compose declarative
 * card/badge/tag specs, SHELL the keyed-batch to a (here injected) FUI CLI, and ASSEMBLE the intents grid
 * — with per-entry isolation and the producer-pin / missing-artifact hard errors. The injected runner
 * stands in for the pinned `../frontierui/dist/tools/component-render/cli.mjs` so the test needs no sibling
 * FUI checkout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  runBuildBatch,
  renderComponents,
  renderIntentGrid,
  renderProjectGrid,
  renderBacklogGrid,
  findComponentPlaceholders,
  spliceComponents,
  spliceComponentsBatch,
  projectIconHtml,
  statusTone,
  tierTagConfig,
  tierRank,
  TIER_ORDER,
  EXPECTED_PRODUCER,
  COMPONENT_BATCH_SIZE,
  COMPONENT_BATCH_INPUT_BYTES,
  planComponentBatches,
  PINNED_CLI_RELATIVE,
  resolveFuiRoot,
} from '../component-render-build-hook.cjs';

// A throwaway "repo root" whose sibling ../frontierui/dist/tools/component-render/cli.mjs exists, so the
// hard missing-artifact gate passes and the injected runner (not the real artifact) does the rendering.
let stubRoot;
beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'we-cr-hook-'));
  stubRoot = path.join(base, 'webeverything');
  fs.mkdirSync(stubRoot, { recursive: true });
  const cli = path.resolve(stubRoot, PINNED_CLI_RELATIVE);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '// stub pinned artifact for tests\n');
});
afterAll(() => { try { fs.rmSync(stubRoot, { recursive: true, force: true }); } catch { /* noop */ } });

// A fake CLI runner: echoes a keyed-batch envelope, rendering each spec to a trivial deterministic marker
// that embeds its key + component — enough to assert the batch is real, per-key, and dispatched.
function fakeRunner(_cmd, _args, opts) {
  const entries = JSON.parse(opts.input);
  return JSON.stringify({
    producer: EXPECTED_PRODUCER,
    results: entries.map((e) => ({ key: e.key, html: `<span data-c="${e.component}" data-k="${e.key}"></span>` })),
  });
}

const INTENTS = [
  { id: 'motion', name: 'Motion', status: 'active', summary: 'Animation preference vocabulary.',
    dimensions: { intensity: {}, easing: {} } },
  { id: 'density', name: 'Density', status: 'draft', summary: 'Spacing scale.', dimensions: {} },
];

describe('statusTone — status → badge tone', () => {
  it('maps the intent + project status buckets', () => {
    expect(statusTone('active')).toBe('success');
    expect(statusTone('stable')).toBe('success');
    expect(statusTone('draft')).toBe('info');
    expect(statusTone('poc')).toBe('info');
    expect(statusTone('concept')).toBe('warning');
    expect(statusTone('experimental')).toBe('warning');
    expect(statusTone('anything-else')).toBe('neutral');
  });
});

describe('runBuildBatch — producer pin + missing-artifact hard error', () => {
  it('throws a hard build error when the pinned artifact is absent', () => {
    expect(() => runBuildBatch([], '/nonexistent-repo-root-xyz', fakeRunner)).toThrow(/pinned FUI artifact missing/);
  });
  it('throws on a producer-pin mismatch', () => {
    const wrong = () => JSON.stringify({ producer: 'someone-else/9', results: [] });
    expect(() => runBuildBatch([{ key: 'k', component: 'badge', config: {} }], stubRoot, wrong))
      .toThrow(/producer pin mismatch/);
  });
});

describe('resolveFuiRoot — WE_FUI_ROOT env-var override (#2178)', () => {
  const saved = process.env.WE_FUI_ROOT;
  afterAll(() => {
    if (saved === undefined) delete process.env.WE_FUI_ROOT;
    else process.env.WE_FUI_ROOT = saved;
  });

  it('defaults to ../frontierui relative to repoRoot when WE_FUI_ROOT is unset', () => {
    delete process.env.WE_FUI_ROOT;
    expect(resolveFuiRoot('/home/user/webeverything')).toBe(path.resolve('/home/user/frontierui'));
  });

  it('returns the absolute WE_FUI_ROOT path when the env-var is set (lane clone override)', () => {
    process.env.WE_FUI_ROOT = '/home/user/workspace/frontierui';
    expect(resolveFuiRoot('/home/user/.lanes/web-everything/lane-15')).toBe(
      path.resolve('/home/user/workspace/frontierui'),
    );
    delete process.env.WE_FUI_ROOT;
  });

  it('resolves a relative WE_FUI_ROOT against cwd (path.resolve semantics)', () => {
    process.env.WE_FUI_ROOT = '../frontierui';
    const result = resolveFuiRoot('/some/lane');
    expect(path.isAbsolute(result)).toBe(true);
    delete process.env.WE_FUI_ROOT;
  });
});

describe('renderComponents — keyed map, per-entry isolation', () => {
  it('returns a key→html map from one subprocess batch', () => {
    const map = renderComponents(
      [{ key: 'a', component: 'badge', config: {} }, { key: 'b', component: 'tag', config: {} }],
      stubRoot, fakeRunner,
    );
    expect(map.get('a')).toContain('data-c="badge"');
    expect(map.get('b')).toContain('data-c="tag"');
  });
  it('omits a failed entry and keeps the rest', () => {
    const oneFails = (_c, _a, opts) => {
      const entries = JSON.parse(opts.input);
      return JSON.stringify({
        producer: EXPECTED_PRODUCER,
        results: entries.map((e, i) => (i === 0 ? { key: e.key, error: 'boom' } : { key: e.key, html: '<i></i>' })),
      });
    };
    const map = renderComponents(
      [{ key: 'x', component: 'badge', config: {} }, { key: 'y', component: 'tag', config: {} }],
      stubRoot, oneFails,
    );
    expect(map.has('x')).toBe(false);
    expect(map.get('y')).toBe('<i></i>');
  });
  it('is a no-op for an empty spec list (no subprocess)', () => {
    expect(renderComponents([], stubRoot, fakeRunner).size).toBe(0);
  });
});

describe('renderIntentGrid — full render-from-data arc on a fixture', () => {
  it('emits one linking anchor per intent wrapping its SSR card, with search/filter data-*', () => {
    const html = renderIntentGrid(INTENTS, stubRoot, fakeRunner);
    expect(html).toMatch(/^<div class="project-grid" id="intent-grid">/);
    // One anchor per intent, keyed to its id + status, with the haystack for the client filter.
    expect(html).toContain('href="/intents/motion/"');
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-haystack="motion motion animation preference vocabulary. intensity easing"');
    expect((html.match(/class="project-card intent-tile"/g) || []).length).toBe(2);
    // Each anchor carries its rendered card (the fake runner marks it by key).
    expect(html).toContain('data-k="intent-0-card"');
    expect(html).toContain('data-k="intent-1-card"');
  });
  it('uses the .project-card-link overlay, not an <a> wrapping the card (no nested-anchor ghost clones)', () => {
    const html = renderIntentGrid(INTENTS, stubRoot, fakeRunner);
    expect((html.match(/class="project-card-link"/g) || []).length).toBe(INTENTS.length);
    expect(html).not.toMatch(/<a [^>]*class="project-card intent-tile"/);
  });
  it('renders a status badge + one tag per dimension key per tile', () => {
    // Assert the spec batch dispatched the right components: motion has 2 dims → 2 tags + 1 badge + 1 card.
    const seen = [];
    const spyRunner = (_c, _a, opts) => {
      const entries = JSON.parse(opts.input);
      entries.forEach((e) => seen.push(`${e.component}:${e.key}`));
      return fakeRunner(_c, _a, opts);
    };
    renderIntentGrid(INTENTS, stubRoot, spyRunner);
    expect(seen).toContain('badge:intent-0-badge');
    expect(seen).toContain('tag:intent-0-tag-0');
    expect(seen).toContain('tag:intent-0-tag-1');
    expect(seen).toContain('card:intent-0-card');
    // density has zero dimensions → no tags.
    expect(seen).not.toContain('tag:intent-1-tag-0');
  });
  it('is empty-safe (no intents → empty grid, no subprocess crash)', () => {
    expect(renderIntentGrid([], stubRoot, fakeRunner)).toBe('<div class="project-grid" id="intent-grid"></div>');
  });
});

const PROJECTS = [
  { id: 'range-anchor', name: 'Durable Range Anchor', status: 'concept', category: 'standard',
    isSvg: true, icon: '/assets/icons/range-anchor.svg', description: 'A <strong>range</strong> standard.' },
  { id: 'webflows', name: 'Web Flows', status: 'poc', category: 'utility',
    isSvg: false, icon: '\u{1F300}', description: 'Flow orchestration.' },
];

describe('projectIconHtml — icon block per project', () => {
  it('emits an <img> for an SVG-icon project', () => {
    expect(projectIconHtml(PROJECTS[0]))
      .toBe('<img src="/assets/icons/range-anchor.svg" alt="Durable Range Anchor icon" width="48" height="48">');
  });
  it('emits the literal glyph for a non-SVG project', () => {
    expect(projectIconHtml(PROJECTS[1])).toBe('\u{1F300}');
  });
});

describe('renderProjectGrid — home/index grid render-from-data (#2019)', () => {
  it('wraps each tile in a .project-card box with an overlay link, honoring gridClass', () => {
    const html = renderProjectGrid(PROJECTS, {
      repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/`, gridClass: 'project-grid project-grid--centered',
    }, fakeRunner);
    expect(html).toMatch(/^<div class="project-grid project-grid--centered">/);
    expect(html).toContain('href="/projects/range-anchor/"');
    expect((html.match(/class="project-card"/g) || []).length).toBe(2);
    expect(html).toContain('data-k="project-0-card"');
    expect(html).toContain('data-k="project-1-card"');
  });
  it('uses the .project-card-link overlay — NOT an <a> wrapping the card (which would nest the description links and clone empty ghost tiles)', () => {
    // A tile description carries inline `<a>` links; an `<a class="project-card">` wrapping the card makes
    // invalid NESTED anchors, so the browser splits the tile and re-opens an EMPTY clone after every inner
    // link (home: 47 tiles → 71 in the parsed DOM, ~24 empty ghosts — invisible in source, only in the
    // rendered DOM). The overlay anchor (`.project-card-link`, position:absolute; inset:0) is the valid form.
    const html = renderProjectGrid(PROJECTS, { repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/` }, fakeRunner);
    expect(html).toContain('<div class="project-card">');
    expect((html.match(/class="project-card-link"/g) || []).length).toBe(PROJECTS.length);
    // The anti-pattern: an <a …> that itself carries the .project-card class (i.e. wraps the tile).
    expect(html).not.toMatch(/<a [^>]*class="project-card"/);
  });
  it('splices the description verbatim — pre-escaped code examples survive, never decoded to a live tag (#2168)', () => {
    // A runner that echoes the card body sentinel (mimicking the FUI shell) so the splice path is exercised.
    // A description mixes render-me markup (<strong>) with a PRE-ESCAPED code example (&lt;template&gt;). The
    // harness `html:` innerHTML round-trip would DECODE the entity into a live <template> that swallows the
    // page (home rendered only 1 of 3 grids); the sentinel-splice injects it verbatim so the escaping holds.
    const echoBody = (_c, _a, opts) => JSON.stringify({
      producer: EXPECTED_PRODUCER,
      results: JSON.parse(opts.input).map((e) => {
        const desc = (e.config && e.config.bodyParts || []).find((p) => p.className === 'project-desc');
        return { key: e.key, html: `<article class="fui-card"><p class="project-desc">${desc ? desc.html : ''}</p></article>` };
      }),
    });
    const html = renderProjectGrid(
      [{ id: 'r', name: 'R', status: 'concept', isSvg: false, icon: 'A',
        description: 'authored: &lt;template route="/u"&gt; and <strong>bold</strong>' }],
      { repoRoot: stubRoot, hrefFor: (p) => `/p/${p.id}/` }, echoBody,
    );
    expect(html).toContain('authored: &lt;template route="/u"&gt;'); // stays escaped — no page-swallowing tag
    expect(html).not.toContain('<template');                        // never decoded to a live element
    expect(html).toContain('<strong>bold</strong>');                // real markup still renders
    expect(html).not.toContain('PROJECT_DESC_');                    // sentinel fully replaced
  });
  it('dispatches a status badge per tile (render-from-data, no markup-as-source)', () => {
    const seen = [];
    const spyRunner = (_c, _a, opts) => {
      JSON.parse(opts.input).forEach((e) => seen.push(`${e.component}:${e.key}`));
      return fakeRunner(_c, _a, opts);
    };
    renderProjectGrid(PROJECTS, { repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/` }, spyRunner);
    expect(seen).toContain('badge:project-0-badge');
    expect(seen).toContain('card:project-0-card');
    expect(seen).toContain('badge:project-1-badge');
  });
  it('links external tiles with target=_blank when external', () => {
    const html = renderProjectGrid(
      [{ name: 'FrontierUI', status: 'active', isSvg: true, icon: '/x.svg', url: 'https://frontierui.dev', description: 'ref' }],
      { repoRoot: stubRoot, external: true, hrefFor: (p) => p.url }, fakeRunner,
    );
    expect(html).toContain('href="https://frontierui.dev"');
    expect(html).toContain('target="_blank" rel="noopener"');
  });
  it('is empty-safe (no projects → empty grid, no subprocess crash)', () => {
    expect(renderProjectGrid([], { repoRoot: stubRoot, hrefFor: () => '/' }, fakeRunner))
      .toBe('<div class="project-grid"></div>');
  });
});

describe('portfolio tier surfacing — the #2088 Fork 4 / #2133 tier cue + grouping', () => {
  const TIERED = [
    { id: 'x', name: 'X', status: 'poc', tier: 'exploratory', isSvg: false, icon: 'x', description: 'x' },
    { id: 'c', name: 'C', status: 'poc', tier: 'core', isSvg: false, icon: 'c', description: 'c' },
    { id: 'n', name: 'N', status: 'poc', tier: 'contextual', isSvg: false, icon: 'n', description: 'n' },
    { id: 'u', name: 'U', status: 'poc', isSvg: false, icon: 'u', description: 'u' }, // untiered → sorts last
  ];

  it('tierRank orders core < contextual < exploratory < unknown/absent', () => {
    expect(tierRank('core')).toBeLessThan(tierRank('contextual'));
    expect(tierRank('contextual')).toBeLessThan(tierRank('exploratory'));
    expect(tierRank('exploratory')).toBeLessThan(tierRank('nonsense'));
    expect(tierRank(undefined)).toBe(TIER_ORDER.length);
  });

  it('tierTagConfig emits a categorical (set,value) tag spec; null for absent/unknown', () => {
    expect(tierTagConfig('core')).toMatchObject({ set: 'project-tier', value: 'core', label: 'Core' });
    expect(tierTagConfig('exploratory')).toMatchObject({ set: 'project-tier', value: 'exploratory' });
    expect(tierTagConfig(undefined)).toBeNull();
    expect(tierTagConfig('bogus')).toBeNull();
  });

  it('groups the grid core → contextual → exploratory (SSR default), untiered last', () => {
    // The fake runner marks each card by key: card key i tracks the SORTED position, so the DOM order of
    // the card markers reflects the grouping. Assert the sorted order by the project the card spec carried.
    const seenTitles = [];
    const orderRunner = (_c, _a, opts) => {
      JSON.parse(opts.input).forEach((e) => {
        if (e.component === 'card') seenTitles.push(e.config.title);
      });
      return fakeRunner(_c, _a, opts);
    };
    renderProjectGrid(TIERED, { repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/` }, orderRunner);
    expect(seenTitles).toEqual(['C', 'N', 'X', 'U']); // core, contextual, exploratory, untiered
  });

  it('dispatches a project-tier tag per STAMPED tile (none for an untiered tile)', () => {
    const seen = [];
    const spyRunner = (_c, _a, opts) => {
      JSON.parse(opts.input).forEach((e) => seen.push(`${e.component}:${e.key}`));
      return fakeRunner(_c, _a, opts);
    };
    renderProjectGrid(TIERED, { repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/` }, spyRunner);
    // three stamped tiles → three tier tags; the tier tag key is index-in-sorted-order.
    const tierKeys = seen.filter((s) => s.startsWith('tag:project-') && s.endsWith('-tier'));
    expect(tierKeys.length).toBe(3);
  });

  it('puts data-tier on each stamped .project-card wrapper (client re-sort facet); absent when untiered', () => {
    const html = renderProjectGrid(TIERED, { repoRoot: stubRoot, hrefFor: (p) => `/projects/${p.id}/` }, fakeRunner);
    expect(html).toContain('data-tier="core"');
    expect(html).toContain('data-tier="contextual"');
    expect(html).toContain('data-tier="exploratory"');
    // exactly three data-tier attrs (the untiered tile carries none).
    expect((html.match(/data-tier="/g) || []).length).toBe(3);
  });
});

// A fake CLI that renders each card to the REAL card SHELL shape (title + a body-part div carrying the
// spec's html — here the sentinel), so renderBacklogGrid's title-alias rewrite + sentinel splice are
// exercised against production-shaped markup without a sibling FUI checkout.
function cardShellRunner(_cmd, _args, opts) {
  const entries = JSON.parse(opts.input);
  return JSON.stringify({
    producer: EXPECTED_PRODUCER,
    results: entries.map((e) => {
      const body = e.config?.bodyParts?.[0];
      const bodyHtml = `<div class="${body?.className || ''}">${body?.html || ''}</div>`;
      return {
        key: e.key,
        html: `<article class="fui-card ${e.config?.className || ''}">`
          + `<header class="fui-card__header"><h3 class="fui-card__title">${e.config?.title || ''}</h3></header>`
          + `<div class="fui-card__body">${bodyHtml}</div></article>`,
      };
    }),
  });
}

const TILES = [
  { id: '2016-x', num: '2016', title: 'SSR render path', status: 'resolved', kind: 'story', size: 5, tier: undefined,
    innerHtml: '<div class="backlog-badges"><we-badge tone="success">Resolved</we-badge></div>'
      + '<p class="backlog-summary">A summary.</p>' },
  // The regression fixture: a summary the template already entity-escaped (`&lt;template&gt;`) must reach the
  // output STILL escaped — proving the sentinel splice bypasses the happy-dom innerHTML round-trip that would
  // otherwise decode it and leak a raw <template> that swallows the rest of the grid.
  { id: '2110-x', num: '2110', title: 'region inert recipe', status: 'open', kind: 'story', size: 5, tier: 'C',
    innerHtml: '<p class="backlog-summary">materialized onto &lt;template&gt; via the transform</p>' },
];

describe('renderBacklogGrid — backlog tile grid render-from-data (#2018)', () => {
  it('wraps each SSR card in its .project-card filter/link chrome with the data-* facets', () => {
    const html = renderBacklogGrid(TILES, stubRoot, cardShellRunner);
    expect(html).toMatch(/^<div class="project-grid">/);
    expect((html.match(/class="project-card"/g) || []).length).toBe(2);
    expect(html).toContain('data-status="resolved" data-kind="story" data-size="5" data-tier=""');
    expect(html).toContain('data-status="open" data-kind="story" data-size="5" data-tier="C"');
    expect(html).toContain('href="/backlog/2016-x/"');
    expect(html).toContain('class="project-card-link"');
  });

  it('folds #num into the title and aliases .fui-card__title with .project-title for the search filter', () => {
    const html = renderBacklogGrid(TILES, stubRoot, cardShellRunner);
    expect(html).toContain('class="fui-card__title project-title">#2016 SSR render path</h3>');
    expect(html).not.toContain('class="fui-card__title"'); // every title got the alias
  });

  it('splices the trusted macro body verbatim — an already-escaped summary stays escaped (no raw <template>)', () => {
    const html = renderBacklogGrid(TILES, stubRoot, cardShellRunner);
    expect(html).toContain('materialized onto &lt;template&gt; via the transform');
    expect(html).not.toContain('materialized onto <template>');
    expect(html).not.toContain('BACKLOG_BODY_'); // no sentinel leaked into the output
    // The badge markup passed through intact.
    expect(html).toContain('<we-badge tone="success">Resolved</we-badge>');
  });

  it('is empty-safe (no tiles → empty grid, no subprocess crash)', () => {
    expect(renderBacklogGrid([], stubRoot, cardShellRunner)).toBe('<div class="project-grid"></div>');
  });
});

// ── Generic template-facing card/badge primitive (#2098) ──────────────────────────────────────────────
// A runner that renders each spec to a deterministic marker embedding its component + config so the batch,
// the per-placeholder splice, and the one-subprocess-per-page economy are all assertable without a real
// FUI checkout.
function genericRunner(_cmd, _args, opts) {
  const entries = JSON.parse(opts.input);
  return JSON.stringify({
    producer: EXPECTED_PRODUCER,
    results: entries.map((e) => ({
      key: e.key,
      html: `<x data-c="${e.component}" data-title="${e.config?.title || ''}" data-label="${e.config?.label || ''}"></x>`,
    })),
  });
}

describe('findComponentPlaceholders — scan the generic card/badge placeholders (#2098)', () => {
  it('parses a single-quoted data-we-spec into a {component, config} spec', () => {
    const html = `<we-badge data-we-spec='{"component":"badge","config":{"label":"Draft","tone":"info"}}'>Draft</we-badge>`;
    const found = findComponentPlaceholders(html);
    expect(found).toHaveLength(1);
    expect(found[0].component).toBe('badge');
    expect(found[0].config).toEqual({ label: 'Draft', tone: 'info' });
    expect(found[0].key).toBe('we-component-0');
  });
  it('infers the component from the tag name for a bare-config spec, and keys sequentially', () => {
    const html =
      `<we-card data-we-spec='{"title":"A"}'>a</we-card>`
      + `<we-badge data-we-spec='{"label":"B"}'>b</we-badge>`;
    const found = findComponentPlaceholders(html);
    expect(found.map((f) => f.component)).toEqual(['card', 'badge']);
    expect(found[0].config).toEqual({ title: 'A' });
    expect(found[1].config).toEqual({ label: 'B' });
    expect(found.map((f) => f.key)).toEqual(['we-component-0', 'we-component-1']);
  });
  it('parses a we-tag placeholder (#2133 tier cue) — categorical (set,value) config', () => {
    const html = `<we-tag data-we-spec='{"component":"tag","config":{"label":"Core","set":"project-tier","value":"core","shape":"pill"}}' set="project-tier" value="core">Core</we-tag>`;
    const found = findComponentPlaceholders(html);
    expect(found).toHaveLength(1);
    expect(found[0].component).toBe('tag');
    expect(found[0].config).toMatchObject({ set: 'project-tier', value: 'core', label: 'Core' });
  });
  it('ignores a bare <we-tag set value> taxonomy pill (no data-we-spec — client CE owns it)', () => {
    expect(findComponentPlaceholders('<we-tag set="tier" value="A">Agent-ready</we-tag>')).toEqual([]);
  });
  it('skips a placeholder with a malformed spec (left for the client CE path, never aborts)', () => {
    const html = `<we-card data-we-spec='{not json}'>x</we-card>`;
    expect(findComponentPlaceholders(html)).toEqual([]);
  });
  it('ignores a we-card with no data-we-spec attribute', () => {
    expect(findComponentPlaceholders('<we-card>plain</we-card>')).toEqual([]);
  });
  it('is quote-aware — a spec value carrying literal < / > does not terminate the open tag early', () => {
    // The card body/actions JSON legally carries nested markup (`<p>…</p>`); a naive `[^>]*` open-tag
    // matcher would stop at the first `>` inside the JSON and mis-parse. Assert the whole spec is captured.
    const html =
      `<we-card data-we-spec='{"component":"card","config":{"title":"T","bodyParts":[{"tag":"div","html":"<p>a &gt; b</p>"}]}}'>`
      + `<p>a &gt; b</p></we-card>`;
    const found = findComponentPlaceholders(html);
    expect(found).toHaveLength(1);
    expect(found[0].component).toBe('card');
    expect(found[0].config.bodyParts[0].html).toBe('<p>a &gt; b</p>');
  });

  it('does NOT independently render a we-card/we-badge NESTED inside another card spec (single-pass; #2101)', () => {
    // The scan is single-pass: a `we-card` whose `data-we-spec` JSON body embeds a CHILD `we-card`
    // placeholder is found as ONE outer card — the child lives inside the parent's `bodyParts[0].html`
    // STRING, so it is never scanned as its own placeholder and never gets its own SSR fragment. This is
    // the exact invariant `src/intent-pages.njk` (#2101) relies on to keep the implementing-blocks panel a
    // PLAIN `.section-card` wrapper around the block-tile `weCard`s (nesting `weCard`-in-`weCard` would
    // double-escape the child spec and leak a raw placeholder into the rendered parent).
    const child = `<we-card data-we-spec=\\"{&#39;child&#39;:1}\\">c</we-card>`;
    const html =
      `<we-card data-we-spec='{"component":"card","config":{"title":"Panel","bodyParts":[{"tag":"div","html":"${child}"}]}}'>`
      + `${child}</we-card>`;
    const found = findComponentPlaceholders(html);
    // Only the OUTER card is a real placeholder; the child string inside the JSON is not one.
    expect(found).toHaveLength(1);
    expect(found[0].config.title).toBe('Panel');
    // The child markup survives verbatim inside the parent body — proving it was NOT treated as its own spec.
    expect(found[0].config.bodyParts[0].html).toContain('<we-card');
  });
});

describe('spliceComponents — one subprocess per page, splice each placeholder (#2098)', () => {
  it('batches all placeholders on a page in ONE subprocess and splices each fragment in place', () => {
    let calls = 0;
    const counting = (_c, _a, opts) => { calls++; return genericRunner(_c, _a, opts); };
    const html =
      `<main><we-card data-we-spec='{"component":"card","config":{"title":"Hello"}}'>fallback</we-card>`
      + `<we-badge data-we-spec='{"component":"badge","config":{"label":"New"}}'>New</we-badge></main>`;
    const out = spliceComponents(html, stubRoot, counting);
    expect(calls).toBe(1); // one subprocess for the whole page, not one per card
    expect(out).toContain('data-c="card" data-title="Hello"');
    expect(out).toContain('data-c="badge"');
    expect(out).toContain('data-label="New"');
    expect(out).not.toContain('data-we-spec'); // every placeholder was replaced
    expect(out).not.toContain('fallback'); // the JS-off fallback body was replaced by the SSR fragment
  });
  it('returns content unchanged when there is no placeholder (single substring check, no subprocess)', () => {
    let calls = 0;
    const counting = (_c, _a, opts) => { calls++; return genericRunner(_c, _a, opts); };
    const html = '<main><p>no components here</p></main>';
    expect(spliceComponents(html, stubRoot, counting)).toBe(html);
    expect(calls).toBe(0);
  });
  it('isolates a failed spec — leaves that placeholder intact, splices the rest', () => {
    const oneFails = (_c, _a, opts) => {
      const entries = JSON.parse(opts.input);
      return JSON.stringify({
        producer: EXPECTED_PRODUCER,
        results: entries.map((e, i) => (i === 0
          ? { key: e.key, error: 'boom' }
          : { key: e.key, html: `<ok data-k="${e.key}"></ok>` })),
      });
    };
    const html =
      `<we-card data-we-spec='{"component":"card","config":{"title":"Bad"}}'>keep-me</we-card>`
      + `<we-badge data-we-spec='{"component":"badge","config":{"label":"Good"}}'>Good</we-badge>`;
    const out = spliceComponents(html, stubRoot, oneFails);
    expect(out).toContain('keep-me'); // failed placeholder stays intact for the client CE path
    expect(out).toContain('<ok data-k="we-component-1">'); // the healthy one was spliced
  });
});

describe('spliceComponentsBatch — bounded subprocess batches across the build (#2185)', () => {
  // Capture what the (injected) writeFile would persist, keyed by outputPath.
  function makeWriter() {
    const written = new Map();
    return { writeFile: (p, c) => written.set(p, c), written };
  }

  const largeSite = () => Array.from({ length: 1025 }, (_, i) => ({
    outputPath: `/site/${i}/index.html`,
    content: `<we-card data-we-spec='${JSON.stringify({ component: 'card', config: { title: `Card ${i}` } })}'>fallback</we-card>`,
  }));

  it('bounds large renders and preserves every global key and page across batch boundaries', () => {
    const batches = [];
    const boundedRunner = (_cmd, _args, opts) => {
      const entries = JSON.parse(opts.input);
      // Model the CLI output limit without allocating a site-sized HTML response in this fixture.
      if (entries.length > 512) throw Object.assign(new Error('output buffer exceeded'), { code: 'ENOBUFS' });
      batches.push(entries.map(e => e.key));
      expect(opts.maxBuffer).toBe(64 * 1024 * 1024);
      return JSON.stringify({ producer: EXPECTED_PRODUCER,
        results: entries.map(e => ({ key: e.key, html: `<article>${e.config.title} $&</article>` })) });
    };
    const { writeFile, written } = makeWriter();
    expect(spliceComponentsBatch(largeSite(), stubRoot, boundedRunner, writeFile))
      .toEqual({ pages: 1025, components: 1025 });
    expect(batches).toHaveLength(3);
    expect(batches.flat()).toEqual(Array.from({ length: 1025 }, (_, i) => `we-c-${i}`));
    for (let i = 0; i < 1025; i++) {
      expect(written.get(`/site/${i}/index.html`)).toBe(`<article>Card ${i} $&</article>`);
    }
  });

  // PR #6911 smoke: fewer than 512 specs can still exceed the CLI buffer when each card embeds a large
  // backlog page body (largest measured spec 2,097,024 B). Batches must be bounded by bytes, not only count.
  it('splits fewer than 512 specs by input bytes so no batch exceeds the byte budget', () => {
    const body = 'x'.repeat(6 * 1024 * 1024);
    const pages = Array.from({ length: 3 }, (_, i) => ({
      outputPath: `/big/${i}/index.html`,
      content: `<we-card data-we-spec='${JSON.stringify({ component: 'card', config: { title: `Big ${i}`, body } })}'>f</we-card>`,
    }));
    const sizes = [];
    const byteBoundRunner = (_cmd, _args, opts) => {
      const bytes = Buffer.byteLength(opts.input);
      if (bytes > COMPONENT_BATCH_INPUT_BYTES) throw Object.assign(new Error('output buffer exceeded'), { code: 'ENOBUFS' });
      const entries = JSON.parse(opts.input);
      sizes.push(entries.length);
      return JSON.stringify({ producer: EXPECTED_PRODUCER,
        results: entries.map(e => ({ key: e.key, html: `<article>${e.config.title}</article>` })) });
    };
    const { writeFile, written } = makeWriter();
    expect(spliceComponentsBatch(pages, stubRoot, byteBoundRunner, writeFile)).toEqual({ pages: 3, components: 3 });
    expect(sizes).toEqual([2, 1]);
    expect(written.get('/big/2/index.html')).toBe('<article>Big 2</article>');
  });

  it('isolates an oversized spec in its own batch and names it when that batch still fails', () => {
    const huge = { key: 'we-c-1', component: 'card', config: { body: 'y'.repeat(COMPONENT_BATCH_INPUT_BYTES) } };
    const specs = [{ key: 'we-c-0', component: 'badge', config: {} }, huge, { key: 'we-c-2', component: 'badge', config: {} }];
    expect(planComponentBatches(specs).map(b => b.map(s => s.key))).toEqual([['we-c-0'], ['we-c-1'], ['we-c-2']]);
    const calls = [];
    const overflowRunner = (_cmd, _args, opts) => {
      const entries = JSON.parse(opts.input);
      calls.push(entries.map(e => e.key));
      if (entries.some(e => e.key === 'we-c-1')) throw Object.assign(new Error('spawnSync node ENOBUFS'), { code: 'ENOBUFS' });
      return JSON.stringify({ producer: EXPECTED_PRODUCER, results: entries.map(e => ({ key: e.key, html: '<span></span>' })) });
    };
    expect(() => renderComponents(specs, stubRoot, overflowRunner))
      .toThrow(/batch of spec "we-c-1" \(\d{8,} input bytes\) failed: spawnSync node ENOBUFS/);
    expect(calls).toEqual([['we-c-0'], ['we-c-1']]);
  });

  it('plans batches by count when specs are small', () => {
    const specs = Array.from({ length: COMPONENT_BATCH_SIZE + 1 }, (_, i) => ({ key: `k${i}`, component: 'badge', config: {} }));
    expect(planComponentBatches(specs).map(b => b.length)).toEqual([COMPONENT_BATCH_SIZE, 1]);
    expect(planComponentBatches([])).toEqual([]);
  });

  it.each(['buffer', 'producer'])('a later batch %s failure aborts before any SSR page is rewritten', (failure) => {
    let calls = 0;
    const failingRunner = (_cmd, _args, opts) => {
      calls++;
      if (calls === 2 && failure === 'buffer') throw Object.assign(new Error('output buffer exceeded'), { code: 'ENOBUFS' });
      return JSON.stringify({ producer: calls === 2 ? 'stale/0' : EXPECTED_PRODUCER,
        results: JSON.parse(opts.input).map(e => ({ key: e.key, html: '<article>rendered</article>' })) });
    };
    const { writeFile, written } = makeWriter();
    expect(() => spliceComponentsBatch(largeSite(), stubRoot, failingRunner, writeFile))
      .toThrow(failure === 'buffer' ? /output buffer exceeded/ : /producer pin mismatch/);
    expect(calls).toBe(2);
    expect(written.size).toBe(0);
  });

  it('collects placeholders across MANY pages and renders them in ONE subprocess, writing each page back', () => {
    let calls = 0;
    const counting = (_c, _a, opts) => { calls++; return genericRunner(_c, _a, opts); };
    const { writeFile, written } = makeWriter();
    const results = [
      { outputPath: '/site/a/index.html', content:
        `<we-card data-we-spec='{"component":"card","config":{"title":"A"}}'>fa</we-card>` },
      { outputPath: '/site/b/index.html', content:
        `<we-badge data-we-spec='{"component":"badge","config":{"label":"B"}}'>fb</we-badge>`
        + `<we-card data-we-spec='{"component":"card","config":{"title":"B2"}}'>fb2</we-card>` },
      { outputPath: '/site/plain/index.html', content: '<p>no components</p>' }, // substring-skip
    ];
    const stat = spliceComponentsBatch(results, stubRoot, counting, writeFile);
    expect(calls).toBe(1); // ONE subprocess for all pages, not one per page
    expect(stat).toEqual({ pages: 2, components: 3 });
    expect(written.get('/site/a/index.html')).toContain('data-title="A"');
    expect(written.get('/site/a/index.html')).not.toContain('data-we-spec');
    expect(written.get('/site/a/index.html')).not.toContain('fa'); // JS-off fallback replaced
    expect(written.get('/site/b/index.html')).toContain('data-label="B"');
    expect(written.get('/site/b/index.html')).toContain('data-title="B2"');
    expect(written.has('/site/plain/index.html')).toBe(false); // untouched, never rewritten
  });

  it('no HTML results / no placeholders → no subprocess, no writes', () => {
    let calls = 0;
    const counting = (_c, _a, opts) => { calls++; return genericRunner(_c, _a, opts); };
    const { writeFile, written } = makeWriter();
    expect(spliceComponentsBatch([], stubRoot, counting, writeFile)).toEqual({ pages: 0, components: 0 });
    expect(spliceComponentsBatch(
      [{ outputPath: '/site/x/index.html', content: '<p>plain</p>' },
       { outputPath: '/site/data.json', content: 'data-we-spec but not html' }],
      stubRoot, counting, writeFile,
    )).toEqual({ pages: 0, components: 0 });
    expect(calls).toBe(0);
    expect(written.size).toBe(0);
  });

  it('isolates a failed spec across pages — leaves that placeholder intact, splices the rest', () => {
    const firstFails = (_c, _a, opts) => {
      const entries = JSON.parse(opts.input);
      return JSON.stringify({
        producer: EXPECTED_PRODUCER,
        results: entries.map((e, i) => (i === 0
          ? { key: e.key, error: 'boom' }
          : { key: e.key, html: `<ok data-k="${e.key}"></ok>` })),
      });
    };
    const { writeFile, written } = makeWriter();
    // Page has a failing (key we-c-0) AND a healthy (key we-c-1) placeholder, so it IS rewritten: the
    // failed one stays intact for the client CE path, the healthy one is spliced.
    const results = [
      { outputPath: '/site/mixed/index.html', content:
        `<we-card data-we-spec='{"component":"card","config":{"title":"Bad"}}'>keep-me</we-card>`
        + `<we-badge data-we-spec='{"component":"badge","config":{"label":"Good"}}'>g</we-badge>` },
    ];
    const stat = spliceComponentsBatch(results, stubRoot, firstFails, writeFile);
    expect(stat.components).toBe(2);
    const out = written.get('/site/mixed/index.html');
    expect(out).toContain('keep-me'); // failed placeholder intact for client CE path
    expect(out).toContain('data-we-spec'); // ...its placeholder element survives
    expect(out).toContain('<ok data-k="we-c-1">'); // the healthy one was spliced
  });
});
