// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import nunjucks from 'nunjucks';
import { Window } from 'happy-dom';

const root = `${process.cwd()}/`;
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const statuses = ['open', 'active', 'preparing', 'parked', 'closed', 'resolved'];
const fixture = statuses.map((status, i) => ({
  id: `${i}-fixture`, num: String(i), title: `${status} fixture`, status,
  kind: 'story', size: 3, summary: `${status} summary`, tags: [], children: [], blockers: [],
}));

function renderTracked(resolvedView, items = fixture) {
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(`${root}src/_includes`), { autoescape: true });
  env.addFilter('where', (list, key, value) => (list || []).filter((item) => item[key] === value));
  let tiles;
  // Exercise the real template producer without invoking the FUI build subprocess.
  env.addFilter('weBacklogGrid', (rows) => { tiles = rows; return '<div class="project-grid"></div>'; });
  const html = env.render('backlog-tracked.njk', { backlog: items, resolvedView, backlogMeta: {} });
  return { html, tiles };
}

describe('resolved backlog static split', () => {
  it('keeps every non-resolved status on the main grid and only resolved on the archive', () => {
    expect(renderTracked(false).tiles.map((item) => item.status)).toEqual(statuses.slice(0, -1));
    expect(renderTracked(true).tiles.map((item) => item.status)).toEqual(['resolved']);
    const main = read('src/backlog.njk');
    const archive = read('src/backlog-resolved.njk');
    expect(main).toMatch(/set resolvedView = false/);
    expect(archive).toMatch(/set resolvedView = true/);
    for (const source of [main, archive]) expect(source).toContain('include "backlog-tracked.njk"');
    expect(archive).toContain('permalink: /backlog/resolved/');
    expect(archive).toContain('layout: base.njk');
    expect(main).toContain('href="/backlog/resolved/"');
    expect(archive).toContain('href="/backlog/"');
    expect(archive).toContain('/assets/js/home-display.js');
  });

  it('does not grow the main tile payload when resolved history grows', () => {
    const history = Array.from({ length: 1000 }, (_, i) => ({ ...fixture.at(-1), id: `history-${i}` }));
    expect(renderTracked(false, fixture.concat(history)).tiles).toEqual(renderTracked(false).tiles);
    expect(renderTracked(true, fixture.concat(history)).tiles).toHaveLength(1001);
  });

  it('uses the same tile bodies and facets, with resolved selected by default under a separate saved-state key', () => {
    const { html, tiles } = renderTracked(true);
    expect(tiles[0].innerHtml).toContain('resolved summary');
    expect(tiles[0]).toMatchObject({ kind: 'story', size: 3, status: 'resolved' });
    expect(html).toContain('Resolved work');
    expect(html).toContain('data-status-default-exclude=""');
    expect(html).toContain('data-status-chip="resolved" selected');
    expect(html).toContain('data-kind-chip="story"');
    expect(html).toContain('data-size-chip="3"');
    expect(html).toContain('data-home-display');
    const js = read('src/assets/js/home-display.js');
    expect(js).toContain('section.dataset.statusDefaultExclude');
    expect(js).toContain("statusAll, statusDefaultExclude, activeStatuses");
  });

  it('opens resolved history despite persisted pre-split filters, and still filters by kind, size and search', () => {
    const window = new Window();
    try {
      window.document.body.innerHTML = renderTracked(true).html;
      const section = window.document.querySelector('section');
      const grid = section.querySelector('.project-grid');
      grid.innerHTML = '<div class="project-card" data-status="resolved" data-kind="story" data-size="3"><h3 class="project-title">Delivered fixture</h3><p>resolved summary</p></div>';
      window.localStorage.setItem('we-status-filter:Tracked work', '["open","active","parked","resolved"]');
      window.localStorage.setItem('we-kind-filter:Tracked work', '[]');
      window.localStorage.setItem('we-search-filter:Tracked work', 'old query');
      window.eval(read('src/assets/js/home-display.js'));
      window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
      const card = grid.querySelector('.project-card');
      const chip = (facet, value) => section.querySelector(`[data-${facet}-chip="${value}"]`);
      const click = (element) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      expect(card.classList.contains('is-filtered-out')).toBe(false);
      expect(chip('status', 'resolved').getAttribute('aria-pressed')).toBe('true');
      expect(section.querySelector('.home-filter').value).toBe('');
      // Persist explicit empty subsets, then re-initialize to exercise restoration as well as clicks.
      for (const facet of ['kind', 'size']) {
        const key = `we-${facet}-filter:Resolved work`;
        window.localStorage.setItem(key, '[]');
        window.eval(read('src/assets/js/home-display.js'));
        window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
        expect(card.classList.contains('is-filtered-out')).toBe(true);
        click(chip(facet, facet === 'kind' ? 'story' : '3'));
        expect(card.classList.contains('is-filtered-out')).toBe(false);
      }
      const search = section.querySelector('.home-filter');
      search.value = 'no match';
      search.dispatchEvent(new window.Event('input'));
      expect(card.classList.contains('is-filtered-out')).toBe(true);
      search.value = 'delivered';
      search.dispatchEvent(new window.Event('input'));
      expect(card.classList.contains('is-filtered-out')).toBe(false);
    } finally {
      window.happyDOM.cancelAsync();
    }
  });

  it('keeps resolved items out of the prioritisation table even if stale batch flags remain', () => {
    const source = read('src/backlog.njk');
    const start = source.indexOf('{% set leverageItems =');
    const end = source.indexOf('{% set countBatch =', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const env = new nunjucks.Environment();
    env.addFilter('where', (list, key, value) => list.filter((item) => item[key] === value));
    const items = fixture.map((item) => ({ ...item, activeBatchable: ['active', 'resolved'].includes(item.status) }));
    const rows = JSON.parse(env.renderString(source.slice(start, end) + '{{ tableRows | dump | safe }}', { backlog: items }));
    expect(rows.some((item) => item.status === 'resolved')).toBe(false);
    expect(rows.some((item) => item.status === 'open')).toBe(true);
    expect(rows.some((item) => item.status === 'active')).toBe(true);
  });

  it('checks available built artifacts and refuses incomplete sites or oversized pages with an operator fallback', () => {
    const main = `${root}_site/backlog/index.html`;
    if (!existsSync(main)) {
      expect(existsSync(`${root}_site`), 'Incomplete _site: built-site checks require _site/backlog/index.html').toBe(false);
      return; // All template/data guarantees above run without a build.
    }
    expect(statSync(main).size, '/backlog/ must stay below 20 MiB; inspect non-resolved sections before deployment').toBeLessThan(20 * 1024 * 1024);
    const archive = `${root}_site/backlog/resolved/index.html`;
    expect(existsSync(archive), 'Built site is incomplete: rebuild with the resolved archive').toBe(true);
    expect(statSync(archive).size, 'Resolved archive exceeds 24 MiB: report to the operator for a pagination ruling before deployment').toBeLessThanOrEqual(24 * 1024 * 1024);
    expect(readFileSync(main, 'utf8')).not.toMatch(/class="project-card[^"\n]*"[^>]*data-status="resolved"/);
  });
});
