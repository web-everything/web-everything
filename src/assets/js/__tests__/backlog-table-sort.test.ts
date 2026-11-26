import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const script = readFileSync('src/assets/js/backlog-table-sort.js', 'utf8');
const row = (id: number) => `<tr data-kind="task" data-readiness="batchable" data-search="${id} title"><td data-sort-val="${id}">${id}</td><td data-sort-val="${['', 'Beta', 'Gamma', 'Alpha'][id]}">Title</td></tr>`;
let fetcher: any;
let listeners: any[];
function mount(saved = false) {
  if (saved) localStorage.setItem('we-backlog-priority-search', '3');
  document.body.innerHTML = `<input data-ptable-search><button data-pkind="task" aria-pressed="true">Task</button>
    <button data-pkind="decision" aria-pressed="true">Decision</button>
    <span data-pcount-full="3" data-pcount-nofiller="2">3</span><strong data-ptable-count>3</strong>
    <table class="sortable" data-prio-chunks="/one /two"><thead><tr><th data-sort-key="id" data-sort-type="num">ID</th><th data-sort-key="title" data-sort-type="text">Title</th></tr></thead><tbody>${row(1)}</tbody></table>
    <button data-prio-load>Show all 3 rows</button><span data-prio-status role="status"></span>`;
  // Happy DOM 12 lacks HTMLTableCellElement.cellIndex. Supply the browser getter
  // on fixture headers so the real sorter reads the selected column's values.
  document.querySelectorAll('th').forEach(header => {
    Object.defineProperty(header, 'cellIndex', {
      get: () => Array.from(header.parentElement!.children).indexOf(header),
    });
  });
  new Function(script)();
}
const ids = () => Array.from(document.querySelectorAll('tbody tr:not(.ptable-empty)')).map(row => row.firstElementChild!.textContent);
async function loaded() { await vi.waitFor(() => expect(ids()).toHaveLength(3)); }
beforeEach(() => {
  localStorage.clear();
  listeners = [];
  const add = document.addEventListener.bind(document);
  vi.spyOn(document, 'addEventListener').mockImplementation((...args: any[]) => {
    listeners.push(args);
    add(args[0], args[1], args[2]);
  });
  fetcher = vi.fn().mockImplementation(async (url: string) => ({ ok: true, text: async () => row(url === '/one' ? 2 : 3) }));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  listeners.forEach(args => document.removeEventListener(args[0], args[1], args[2]));
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '';
});

describe('prioritisation lazy loading', () => {
  it('keeps server totals until explicitly showing all rows, loading each chunk once', async () => {
    mount();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.querySelector('[data-ptable-count]')!.textContent).toBe('3');
    expect(document.querySelector('[data-pcount-full]')!.textContent).toBe('3');
    (document.querySelector('[data-prio-load]') as HTMLElement).click();
    await loaded();
    expect(ids()).toEqual(['1', '2', '3']);
    expect(fetcher.mock.calls.map((call: any[]) => call[0])).toEqual(['/one', '/two']);
    expect((document.querySelector('[data-prio-load]') as HTMLElement).hidden).toBe(true);
  });

  it('loads before sorting and shares the pending load across repeated actions', async () => {
    mount();
    const header = document.querySelector('th') as HTMLElement;
    header.click(); header.click();
    await loaded();
    expect(ids()).toEqual(['1', '2', '3']); // descending first, ascending second
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sorts numeric and text columns in both directions with click and keyboard', async () => {
    mount();
    const numeric = document.querySelector('[data-sort-key="id"]') as HTMLElement;
    const title = document.querySelector('[data-sort-key="title"]') as HTMLElement;
    numeric.click();
    await loaded();
    expect(ids()).toEqual(['3', '2', '1']);
    numeric.click();
    expect(ids()).toEqual(['1', '2', '3']);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(ids()).toEqual(['3', '1', '2']);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(ids()).toEqual(['2', '1', '3']);
    expect(numeric.hasAttribute('data-sort-dir')).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['pending', 'completed'])('shares loaded and pending rows across script reinitialization (%s)', async (phase) => {
    let release!: () => void;
    const responseReady = new Promise<void>(resolve => { release = resolve; });
    fetcher.mockImplementationOnce(async () => ({ ok: true, text: async () => { await responseReady; return row(2); } }));
    mount();
    const button = document.querySelector('[data-prio-load]') as HTMLButtonElement;
    button.click();
    if (phase === 'completed') {
      release();
      await loaded();
    }

    new Function(script)();
    // Exercise the new initialization while the original load is pending or retained.
    const table = document.querySelector('table') as HTMLTableElement & { withPrioRows: (action: () => void) => void };
    const action = vi.fn();
    table.withPrioRows(action);
    release();
    await vi.waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(ids()).toEqual(['1', '2', '3']);
    expect(new Set(ids()).size).toBe(3);
    expect(fetcher.mock.calls.map((call: any[]) => call[0])).toEqual(['/one', '/two']);
    expect(button.hidden).toBe(true);
    (document.querySelector('th') as HTMLElement).click();
    expect(ids()).toEqual(['3', '2', '1']);
    (document.querySelector('[data-pkind="task"]') as HTMLElement).click();
    expect(document.querySelector('[data-ptable-count]')!.textContent).toBe('0');
  });

  it.each(['search', 'chip', 'restore'])('loads all rows before applying %s and updates counts', async (action) => {
    mount(action === 'restore');
    if (action === 'search') {
      const input = document.querySelector('input') as HTMLInputElement;
      input.value = '3'; input.dispatchEvent(new Event('input'));
    }
    if (action === 'chip') (document.querySelector('[data-pkind="task"]') as HTMLElement).click();
    await loaded();
    await vi.waitFor(() => expect(document.querySelector('[data-ptable-count]')!.textContent).toBe(action === 'chip' ? '0' : '1'));
  });

  it.each(['http', 'malformed', 'oversized'])('fails atomically on %s and offers a retry without duplicates', async (failure) => {
    mount();
    fetcher.mockImplementationOnce(async () => ({ ok: true, text: async () => row(2) }))
      .mockImplementationOnce(async () => ({ ok: failure !== 'http', text: async () => failure === 'oversized' ? row(3).repeat(251) : '<tr><td>bad</td></tr>' }));
    (document.querySelector('[data-prio-load]') as HTMLElement).click();
    await vi.waitFor(() => expect(document.querySelector('[data-prio-status]')!.textContent).toContain('Retry'));
    expect(ids()).toEqual(['1']);
    expect(document.querySelector('[data-ptable-count]')!.textContent).toBe('3');
    new Function(script)();
    (document.querySelector('[data-prio-load]') as HTMLElement).click();
    await loaded();
    expect(ids()).toEqual(['1', '2', '3']);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
