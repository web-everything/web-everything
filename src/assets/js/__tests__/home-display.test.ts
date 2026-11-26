import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const script = readFileSync('src/assets/js/home-display.js', 'utf8');
const tile = (id: number, status = 'open') => `<div class="project-card" data-status="${status}" data-kind="story" data-size="3" data-tier="A"><a class="project-card-link" href="/backlog/${id}/"></a><h3 class="project-title">Tile ${id}</h3><p>summary</p></div>`;
const fragment = (id: number) => `<div class="project-grid">${tile(id)}</div>`;
let fetcher: any;
let listeners: any[];
function mount(saved?: string, resolved = false) {
  const heading = resolved ? 'Resolved work' : 'Tracked work';
  if (saved === 'search') localStorage.setItem('we-search-filter:' + heading, '3');
  if (saved === 'view') localStorage.setItem('we-home-view:' + heading, 'list');
  if (saved === 'kind') localStorage.setItem('we-kind-filter:' + heading, '[]');
  if (saved === 'status') localStorage.setItem('we-status-filter:' + heading, '[]');
  if (saved === 'size') localStorage.setItem('we-size-filter:' + heading, '[]');
  if (saved === 'tier') localStorage.setItem('we-tier-filter:' + heading, '[]');
  document.body.innerHTML = `<section data-tile-chunks="/one /two" data-tile-total="3" data-status-default-exclude="${resolved ? '' : 'closed'}">
    <h2 class="section-title">${heading} <span data-count-target>3</span></h2>
    <button data-status-chip="${resolved ? 'resolved' : 'open'}">Status</button><button data-status-chip="closed">Closed</button><button data-kind-chip="story">Story</button><button data-kind-chip="decision">Decision</button>
    <button data-size-chip="3">3</button><button data-size-chip="5">5</button><button data-tier-chip="A">A</button><button data-tier-chip="B">B</button>
    <div data-home-display><button class="view-toggle-btn" data-view="grid">Grid</button><button class="view-toggle-btn" data-view="list">List</button>
    <div class="home-search"><button class="home-search-btn">Search</button><input class="home-filter"></div></div>
    <div class="project-grid">${tile(1, resolved ? 'resolved' : 'open')}</div>
    <button data-tiles-load>Show all 3 tiles</button><span data-tiles-status role="status"></span></section>`;
  new Function(script)();
}
const cards = () => Array.from(document.querySelectorAll('.project-card'));
const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
async function loaded() { await vi.waitFor(() => expect(cards()).toHaveLength(3)); }
beforeEach(() => {
  localStorage.clear();
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((...args: any[]) => {
    listeners.push(args); add(args[0], args[1], args[2]);
  });
  fetcher = vi.fn().mockImplementation(async (url: string) => ({ ok: true, text: async () => fragment(url === '/one' ? 2 : 3) }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  listeners.forEach(args => document.removeEventListener(args[0], args[1], args[2]));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '';
});
describe('home display bounded tile loading', () => {
  it('keeps the server total with no initial requests, then appends direct tiles once and emits a bubbling event', async () => {
    mount();
    const event = vi.fn(); document.body.addEventListener('backlog:tiles-loaded', event, { once: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('[data-count-target]')!.textContent).toBe('3');
    click('[data-tiles-load]'); await loaded();
    expect(document.querySelectorAll('.project-grid > .project-card')).toHaveLength(3);
    expect(document.querySelectorAll('.project-grid')).toHaveLength(1);
    expect(event).toHaveBeenCalledTimes(1);
    expect((document.querySelector('[data-tiles-load]') as HTMLElement).hidden).toBe(true);
    click('[data-view="list"]'); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['chip', 'size', 'tier', 'status', 'search', 'escape', 'view'])('loads the full corpus before a %s action', async action => {
    mount();
    const input = document.querySelector('input') as HTMLInputElement;
    if (['chip', 'size', 'tier', 'status'].includes(action)) click(action === 'status' ? '[data-status-chip="open"]' : action === 'chip' ? '[data-kind-chip="decision"]' : action === 'size' ? '[data-size-chip="5"]' : '[data-tier-chip="B"]');
    if (action === 'search') { input.value = '3'; input.dispatchEvent(new Event('input')); }
    if (action === 'escape') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    if (action === 'view') click('[data-view="list"]');
    expect(cards()).toHaveLength(1);
    expect(document.querySelector('[data-count-target]')!.textContent).toBe('3');
    await loaded();
    await vi.waitFor(() => expect(cards().filter(card => !card.classList.contains('is-filtered-out'))).toHaveLength(action === 'search' ? 1 : ['chip', 'size', 'tier', 'status'].includes(action) ? 0 : 3));
    if (action === 'view') expect(document.querySelector('section')!.classList.contains('home-list-view')).toBe(true);
  });
  it.each(['search', 'view', 'kind', 'status', 'size', 'tier'])('loads automatically for persisted %s preferences', async saved => {
    mount(saved); await loaded();
    await vi.waitFor(() => expect(document.querySelector('[data-count-target]')!.textContent).toBe(saved === 'search' ? '1' : saved === 'view' ? '3' : '0'));
  });
  it('shares a pending load across actions and script reinitialization, using the latest search', async () => {
    mount();
    click('[data-view="list"]');
    new Function(script)();
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = '2'; input.dispatchEvent(new Event('input'));
    input.value = '3'; input.dispatchEvent(new Event('input'));
    await loaded();
    await vi.waitFor(() => expect(document.querySelector('[data-count-target]')!.textContent).toBe('1'));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cards().find(card => !card.classList.contains('is-filtered-out'))!.textContent).toContain('Tile 3');
  });
  it('reloads chunks when a hot reload replaces a loaded grid with the server preview', async () => {
    mount(); click('[data-tiles-load]'); await loaded();
    document.querySelector('.project-grid')!.innerHTML = tile(1);
    document.querySelector('[data-count-target]')!.textContent = '3';
    (document.querySelector('[data-tiles-load]') as HTMLButtonElement).hidden = false;
    (document.querySelector('[data-tiles-load]') as HTMLButtonElement).disabled = false;
    new Function(script)();
    expect(document.querySelector('[data-count-target]')!.textContent).toBe('3');
    expect(fetcher).toHaveBeenCalledTimes(2);
    click('[data-view="list"]'); await loaded();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(document.querySelectorAll('.project-grid > .project-card')).toHaveLength(3);
  });
  it('keeps resolved history visible with a separate saved-state key', async () => {
    localStorage.setItem('we-status-filter:Tracked work', '[]');
    fetcher.mockImplementation(async (url: string) => ({ ok: true, text: async () => fragment(url === '/one' ? 2 : 3).replace('data-status="open"', 'data-status="resolved"') }));
    mount(undefined, true); expect(fetcher).not.toHaveBeenCalled();
    click('[data-tiles-load]'); await loaded();
    expect(cards().every(card => !card.classList.contains('is-filtered-out'))).toBe(true);
    expect(document.querySelector('[data-count-target]')!.textContent).toBe('3');
  });
  it.each(['http', 'malformed', 'too-many', 'too-big', 'duplicate', 'incomplete'])('fails atomically on %s and retries without duplicates', async failure => {
    mount();
    let bad = failure === 'too-many' ? `<div class="project-grid">${tile(3).repeat(101)}</div>`
      : failure === 'too-big' ? fragment(3) + ' '.repeat(2 * 1024 * 1024)
      : failure === 'duplicate' ? fragment(2)
      : failure === 'incomplete' ? '<div class="project-grid"></div>' : '<p>invalid</p>';
    if (failure === 'incomplete') document.querySelector('section')!.dataset.tileTotal = '4';
    fetcher.mockImplementationOnce(async () => ({ ok: true, text: async () => fragment(2) }))
      .mockImplementationOnce(async () => ({ ok: failure !== 'http', text: async () => failure === 'incomplete' ? fragment(3) : bad }));
    click('[data-view="list"]');
    await vi.waitFor(() => expect(document.querySelector('[data-tiles-status]')!.textContent).toContain('Retry'));
    expect(cards()).toHaveLength(1);
    expect(document.querySelector('[data-count-target]')!.textContent).toBe('3');
    expect(document.querySelector('section')!.classList.contains('home-list-view')).toBe(false);
    document.querySelector('section')!.dataset.tileTotal = '3';
    click('[data-tiles-load]'); await loaded();
    expect(cards().map(card => card.querySelector('a')!.getAttribute('href'))).toEqual(['/backlog/1/', '/backlog/2/', '/backlog/3/']);
  });
});
