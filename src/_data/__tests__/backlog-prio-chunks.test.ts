import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { freezeBacklogCorpus, withFrozenBacklogDir } from './frozen-backlog';

const require = createRequire(import.meta.url);
const corpus = freezeBacklogCorpus(resolve('backlog'));
afterAll(() => corpus.dispose());
const load = withFrozenBacklogDir(corpus.dir, () => require('../backlog.js'));
const { build } = require('../backlogPrioChunks.js');
const backlog = load();
const model = build(backlog);
const nunjucks = require('nunjucks');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader('src/_includes'), { autoescape: true });
require('../../../eleventy/filters.cjs').registerFilters({ addFilter: (name: string, fn: any) => env.addFilter(name, fn) }, resolve('.'));
const context = { backlogMeta: require('../backlogMeta.js') };
const render = (rows: any[]) => env.renderString('{% include "backlog-prio-rows.njk" %}', { ...context, prioRows: rows });
const pieces = [model.inline, ...model.chunks.map((chunk: any) => chunk.rows)];
const html = pieces.map(render);

it('gates the full-build acceptance ceiling and deployment asset guard before merge', () => {
  const workflow = require('js-yaml').safeLoad(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const steps = workflow.jobs.smoke.steps;
  const build = steps.findIndex((step: any) => step.run === 'npm run build:docs');
  const check = steps.findIndex((step: any) => step.run?.includes('node --test tests/build/site-asset-size.test.mjs'));
  expect(build).toBeGreaterThanOrEqual(0);
  expect(check).toBeGreaterThan(build);
  expect(steps[check].run).toContain('node scripts/check-site-asset-size.mjs _site\n');
  expect(steps[check]['working-directory']).toBe('web-everything');
  expect(steps[check].if).toBe(steps[build].if);
});

describe('bounded prioritisation output from the current backlog corpus', () => {
  it('preserves the old ranking and pinned groups, with every card reachable exactly once in order', () => {
    const expected = env.renderString(`{% set ranked = backlog | where("status", "active") | where("kind", "decision") | sort(attribute="leverageScore", reverse=true) %}
{% set preparing = backlog | where("status", "preparing") | sort(attribute="leverageScore", reverse=true) %}
{% set batching = backlog | where("status", "active") | where("activeBatchable", true) | sort(attribute="leverageScore", reverse=true) %}
{% set open = backlog | where("status", "open") | sort(attribute="leverageScore", reverse=true) %}
{% for item in ranked.concat(preparing).concat(batching).concat(open) %}{{ item.id }}\n{% endfor %}`, { backlog }).trim().split('\n');
    const ids = html.flatMap((piece: string) => {
      const body = document.createElement('tbody');
      body.innerHTML = piece;
      return Array.from(body.querySelectorAll('tr')).map(row => row.querySelector('td a')!.getAttribute('href')!.split('/')[2]);
    });
    expect(ids).toEqual(expected);
    expect(ids).toEqual(model.tableRows.map((item: any) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bounds the inline part and every emitted fragment to 250 rows and under 3 MiB', () => {
    expect(model.tableRows.length).toBeGreaterThan(250);
    for (const piece of html) {
      expect((piece.match(/<tr /g) || []).length).toBeLessThanOrEqual(250);
      expect(Buffer.byteLength('<table><tbody>' + piece + '</tbody></table>')).toBeLessThan(3 * 1024 * 1024);
    }
    expect(model.urls).toEqual(model.chunks.map((chunk: any) => chunk.url));
  });

  it('uses the shared include in both producers and paginates exactly one chunk per URL', () => {
    const index = readFileSync('src/backlog.njk', 'utf8');
    const fragment = require('gray-matter')(readFileSync('src/backlog-prio-rows.njk', 'utf8'));
    expect(index).toContain('set prioRows = backlogPrioChunks.inline');
    expect(index).toContain('include "backlog-prio-rows.njk"');
    expect(index).not.toContain('for item in tableRows');
    expect(fragment.data.pagination).toMatchObject({ data: 'backlogPrioChunks.chunks', size: 1, alias: 'chunk' });
    expect(fragment.data.layout).toBe(false);
    model.chunks.forEach((chunk: any) => {
      expect(env.renderString(fragment.data.permalink, { chunk })).toBe(chunk.url);
      expect(env.renderString(fragment.content, { ...context, chunk }).trim()).toBe(render(chunk.rows).trim());
    });
  });

  it('handles empty, boundary and growing corpora without growing any row batch', () => {
    for (const size of [0, 250, 251, 501, 10001]) {
      const growing = build(Array.from({ length: size }, (_, id) => ({ id, status: 'open', leverageScore: 0 })));
      const batches = [growing.inline, ...growing.chunks.map((chunk: any) => chunk.rows)];
      expect(batches.flat().length).toBe(size);
      expect(Math.max(...batches.map((rows: any[]) => rows.length))).toBeLessThanOrEqual(250);
    }
  });
});

const { build: buildTiles } = require('../backlogTileChunks.js');
const tileModels = buildTiles(backlog);
const renderTiles = (items: any[]) => env.render('backlog-tiles.njk', { ...context, tileItems: items });

for (const view of ['tracked', 'resolved']) {
  describe(`bounded ${view} tile output from the current backlog corpus`, () => {
    const tiles = tileModels[view];
    const batches = [tiles.inline, ...tiles.chunks.map((chunk: any) => chunk.items)];
    const rendered = batches.map(renderTiles);
    it('preserves status ordering and selection with every id exactly once across inline and fragments', () => {
      const order = view === 'resolved' ? ['resolved'] : ['open', 'active', 'preparing', 'parked', 'closed'];
      const expected = order.flatMap(status => backlog.filter((item: any) => item.status === status).map((item: any) => item.id));
      const ids = rendered.flatMap((html: string) => {
        const body = document.createElement('div');
        body.innerHTML = html;
        return Array.from(body.querySelectorAll('.project-grid > .project-card > .project-card-link'))
          .map(link => link.getAttribute('href')!.split('/')[2]);
      });
      expect(ids).toEqual(expected);
      expect(ids).toHaveLength(backlog.filter((item: any) => (item.status === 'resolved') === (view === 'resolved')).length);
      expect(new Set(ids).size).toBe(ids.length);
    });
    it('bounds the inline grid and every SSR fragment to 100 tiles and well under 2 MiB', () => {
      expect(tiles.items.length).toBeGreaterThan(100);
      for (const html of rendered) {
        expect((html.match(/class="project-card"/g) || []).length).toBeLessThanOrEqual(100);
        expect(Buffer.byteLength(html)).toBeLessThan(1.75 * 1024 * 1024);
      }
    });
    it('uses the same SSR producer inline and at every paginated chunk URL', () => {
      const fragment = require('gray-matter')(readFileSync(`src/backlog-${view}-tiles.njk`, 'utf8'));
      expect(fragment.data.pagination).toMatchObject({ data: `backlogTileChunks.${view}.chunks`, size: 1, alias: 'chunk' });
      expect(fragment.data.layout).toBe(false);
      expect(fragment.data.eleventyExcludeFromCollections).toBe(true);
      expect(readFileSync('src/_includes/backlog-tracked.njk', 'utf8')).toContain('set tileItems = tileModel.inline');
      expect(readFileSync('src/_includes/backlog-tracked.njk', 'utf8')).toContain('include "backlog-tiles.njk"');
      expect(tiles.urls).toEqual(tiles.chunks.map((chunk: any) => chunk.url));
      tiles.chunks.forEach((chunk: any, i: number) => {
        expect(env.renderString(fragment.data.permalink, { chunk })).toBe(chunk.url);
        expect(env.renderString(fragment.content, { ...context, chunk }).trim()).toBe(rendered[i + 1].trim());
      });
      // Exercise the full inline include, including the server total and fragment manifest.
      const index = env.render('backlog-tracked.njk', { ...context, backlogTileChunks: tileModels, resolvedView: view === 'resolved' });
      const body = document.createElement('div');
      body.innerHTML = index;
      expect(body.querySelectorAll('.project-card')).toHaveLength(100);
      expect(body.querySelector('[data-count-target]')!.textContent).toBe(String(tiles.items.length));
      expect(body.querySelector('section')!.dataset.tileChunks).toBe(tiles.urls.join(' '));
    });
  });
}

it('bounds both tile views for empty, boundary and oversized corpora', () => {
  for (const size of [0, 100, 101, 201, 10001]) {
    const items = Array.from({ length: size }, (_, id) => ({ id, status: 'open' }));
    for (const status of ['open', 'resolved']) {
      const views = buildTiles(items.map(item => ({ ...item, status })));
      const tiles = status === 'open' ? views.tracked : views.resolved;
      const batches = [tiles.inline, ...tiles.chunks.map((chunk: any) => chunk.items)];
      expect(batches.flat()).toHaveLength(size);
      expect(new Set(batches.flat().map((item: any) => item.id)).size).toBe(size);
      expect(Math.max(...batches.map((items: any[]) => items.length))).toBeLessThanOrEqual(100);
    }
  }
});
