// Bounded static fragments are loaded once, atomically, before interacting with the full table.
(function () {
  'use strict';
  document.querySelectorAll('table.sortable').forEach(function (table) {
    var urls = (table.getAttribute('data-prio-chunks') || '').split(/\s+/).filter(Boolean);
    var pending = null;
    var button = document.querySelector('[data-prio-load]');
    var status = document.querySelector('[data-prio-status]');
    table.prioLoaded = urls.length === 0;
    table.withPrioRows = function (action) {
      if (table.prioLoaded) { action(); return; }
      if (!pending) {
        if (button) button.disabled = true;
        if (status) status.textContent = 'Loading all rows…';
        // Fetch sequentially to bound concurrent requests. Stage everything off-DOM so a failure can
        // retry without duplicate rows or filtering an incomplete corpus.
        pending = (async function () {
          var staged = document.createDocumentFragment();
          for (var i = 0; i < urls.length; i++) {
            var response = await fetch(urls[i]);
            if (!response.ok) throw new Error('Could not load rows');
            var body = document.createElement('tbody');
            body.innerHTML = await response.text();
            if (!body.children.length || body.children.length > 250 ||
                Array.prototype.some.call(body.children, function (row) { return row.tagName !== 'TR' || !row.hasAttribute('data-search'); })) {
              throw new Error('Invalid row fragment');
            }
            while (body.firstChild) staged.appendChild(body.firstChild);
          }
          table.querySelector('tbody').appendChild(staged);
          table.prioLoaded = true;
          if (button) button.hidden = true;
          if (status) status.textContent = '';
          table.dispatchEvent(new Event('prio-rows-loaded'));
        })();
      }
      pending.then(action).catch(function () {
        pending = null;
        if (button) { button.disabled = false; button.textContent = 'Retry loading all rows'; }
        if (status) status.textContent = 'Rows could not be loaded. Retry to sort or filter the full table.';
      });
    };
    if (button) button.addEventListener('click', function () { table.withPrioRows(function () { table.dispatchEvent(new Event('prio-apply')); }); });
  });
})();

// Click-to-sort for any `table.sortable` (the /backlog/ Prioritisation table, #258-ish UX).
// Headers carry `data-sort-key` (presence = sortable) and `data-sort-type` (num | text); body cells
// carry `data-sort-val`. Sorting is purely client-side over the already-rendered rows — the server
// emits them in leverage order, and a click re-orders in place. Remaining fragments load before sorting.
(function () {
  'use strict';
  var tables = document.querySelectorAll('table.sortable');
  Array.prototype.forEach.call(tables, function (table) {
    var headers = table.querySelectorAll('thead th[data-sort-key]');
    Array.prototype.forEach.call(headers, function (th) {
      th.style.cursor = 'pointer';
      th.setAttribute('role', 'button');
      th.setAttribute('tabindex', '0');
      var run = function () {
        var col = th.cellIndex;
        var type = th.getAttribute('data-sort-type') || 'text';
        // First click on a column: numeric defaults to descending (most leverage first), text ascending.
        var dir = th.getAttribute('data-sort-dir') === 'asc' ? 'desc'
                : th.getAttribute('data-sort-dir') === 'desc' ? 'asc'
                : (type === 'num' ? 'desc' : 'asc');
        // Reset every header's state + indicator, then set this one.
        Array.prototype.forEach.call(headers, function (o) {
          o.removeAttribute('data-sort-dir');
          var oi = o.querySelector('.sort-ind'); if (oi) oi.textContent = '';
        });
        th.setAttribute('data-sort-dir', dir);
        var ind = th.querySelector('.sort-ind'); if (ind) ind.textContent = dir === 'asc' ? ' ▲' : ' ▼';

        var tbody = table.querySelector('tbody');
        var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
        rows.sort(function (a, b) {
          var av = (a.children[col] && a.children[col].getAttribute('data-sort-val')) || '';
          var bv = (b.children[col] && b.children[col].getAttribute('data-sort-val')) || '';
          var cmp = type === 'num'
            ? (parseFloat(av) || 0) - (parseFloat(bv) || 0)
            : String(av).localeCompare(String(bv));
          return dir === 'asc' ? cmp : -cmp;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      };
      var sort = function () { table.withPrioRows(run); };
      th.addEventListener('click', sort);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sort(); } });
    });
  });
})();

// Client-side filtering for the /backlog/ Prioritisation table — readiness chips, type chips, and a
// free-text box over `data-search`. Deselecting every chip in a group means "no filter" (show all), so
// the table never silently empties from a half-toggled group. The `data-ptable-count` badge tracks
// the visible row count. Sorting (above) and filtering compose: hidden rows just stay display:none.
(function () {
  'use strict';
  var table = document.querySelector('table.sortable');
  if (!table) return;
  var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr'));
  table.addEventListener('prio-rows-loaded', function () {
    rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr:not(.ptable-empty)'));
  });
  table.addEventListener('prio-apply', function () { apply(); });
  // Live accessors — the #2028 persistent-host base (#2122) also copies data-p* attrs onto the wrapped
  // inner <button>, so document.querySelectorAll matches both host and child under the same selector.
  function readyChips() { return Array.prototype.slice.call(document.querySelectorAll('[data-pready]')); }
  function kindChips()  { return Array.prototype.slice.call(document.querySelectorAll('[data-pkind]')); }
  // `splittable` is an ORTHOGONAL facet, not a readiness value — a split candidate (story · size > 8) is
  // ALSO agent-ready or not-ready, so it can't live in the mutually-exclusive readiness group. It's a
  // single ON/OFF toggle (default OFF) that AND-composes with the other filters: when on, narrow to rows
  // carrying `data-splittable`. `splitSummary` is the big "N to split" pill — a one-click shortcut to it.
  function splitChip() { return document.querySelector('[data-psplit]'); }
  // The "Hide low priority" chip — another ORTHOGONAL ON/OFF toggle (default OFF). When on, hide every
  // row marked `priority: low` (#1620, `data-lowprio`) — across ALL readiness buckets (agent-ready,
  // decision, epics…), not just Tier-A filler — and decrement each summary pill's count (see updateCounts
  // in apply()). AND-composes with the facet chips.
  function fillerChip() { return document.querySelector('[data-pfiller]'); }
  // Live accessor — the summary pills are <we-filter-chip> too (see readyChips above).
  function splitSummaryEl() { return document.querySelector('[data-psplitfilter]'); }
  var search = document.querySelector('[data-ptable-search]');
  var countEl = document.querySelector('[data-ptable-count]');
  if (!readyChips().length && !kindChips().length && !search) return;

  // Empty-state row — when the active filter (chip combo, the split toggle, or a persisted search term)
  // hides every row, the table would otherwise look silently broken: a header and nothing under it, with
  // no clue why or how to recover. A persisted filter survives reloads, so this is the common "nothing
  // shows" report. We append one full-width row that names the cause and offers a one-click reset.
  var tbodyEl = table.querySelector('tbody');
  var colCount = table.querySelectorAll('thead th').length || 8;
  var emptyRow = null;
  function ensureEmptyRow() {
    if (emptyRow) return emptyRow;
    emptyRow = document.createElement('tr');
    emptyRow.className = 'ptable-empty';
    emptyRow.innerHTML = '<td colspan="' + colCount + '" style="text-align:center; padding:1.5rem 1rem; '
      + 'color:var(--color-text-muted);">No rows match the current filter. '
      + '<button type="button" data-ptable-reset style="appearance:none; border:1px solid var(--color-border); '
      + 'background:var(--color-surface, #fff); border-radius:0.4rem; padding:0.25rem 0.7rem; font:inherit; '
      + 'font-size:0.9em; cursor:pointer; color:var(--color-primary); font-weight:600;">Clear filters</button></td>';
    emptyRow.querySelector('[data-ptable-reset]').addEventListener('click', function () {
      clearSummary();
      resetAllChips();
      // A full clear DOES drop the sticky view-level filler toggle too (resetAllChips leaves it alone) — the
      // empty-state means every row is hidden, so the recovery must restore low-priority work as well.
      var fc = fillerChip();
      if (fc) fc.setAttribute('aria-pressed', 'false');
      apply();
    });
    tbodyEl.appendChild(emptyRow);
    return emptyRow;
  }

  // ── Visual state + persistence ──────────────────────────────────────────────
  // A chip's pressed state lives in `aria-pressed`; the FUI chip styles highlight
  // `fui-filter-chip--selected` — the class we-filter-chip sets on upgrade, and that home-display.js
  // also mirrors on the Tracked-work chips. Mirror aria-pressed → fui-filter-chip--selected on every
  // render so a click changes the visible state. The resulting filter (which chips are on + the search
  // box) is remembered in localStorage and re-applied on reload, matching every other backlog filter
  // (graph toggle, tab, home chips).
  var READY_KEY = 'we-backlog-priority-ready';
  var KIND_KEY = 'we-backlog-priority-kind';
  var SPLIT_KEY = 'we-backlog-priority-split';
  var FILLER_KEY = 'we-backlog-priority-filler';
  var SEARCH_KEY = 'we-backlog-priority-search';
  function pressedVals(chips, attr) {
    return chips.filter(function (c) { return c.getAttribute('aria-pressed') !== 'false'; })
                .map(function (c) { return c.getAttribute(attr); });
  }
  function splitOn() { var sc = splitChip(); return sc && sc.getAttribute('aria-pressed') === 'true'; }
  function fillerOn() { var fc = fillerChip(); return fc && fc.getAttribute('aria-pressed') === 'true'; }
  function syncVisual() {
    readyChips().concat(kindChips()).forEach(function (c) {
      c.classList.toggle('fui-filter-chip--selected', c.getAttribute('aria-pressed') !== 'false');
    });
    // The split/filler toggles default OFF, so (unlike the groups above) fui-filter-chip--selected tracks pressed === 'true'.
    var sc = splitChip();
    if (sc) sc.classList.toggle('fui-filter-chip--selected', splitOn());
    var fc = fillerChip();
    if (fc) fc.classList.toggle('fui-filter-chip--selected', fillerOn());
  }
  function save() {
    try {
      localStorage.setItem(READY_KEY, JSON.stringify(pressedVals(readyChips(), 'data-pready')));
      localStorage.setItem(KIND_KEY, JSON.stringify(pressedVals(kindChips(), 'data-pkind')));
      localStorage.setItem(SPLIT_KEY, splitOn() ? '1' : '0');
      localStorage.setItem(FILLER_KEY, fillerOn() ? '1' : '0');
      localStorage.setItem(SEARCH_KEY, (search && search.value) || '');
    } catch (e) { /* ignore */ }
  }
  // Restore before the first apply(). A chip not in the saved list is set unpressed; a missing/garbled key
  // leaves the server default (all pressed = no filter) untouched.
  function restore() {
    try {
      var r = JSON.parse(localStorage.getItem(READY_KEY));
      if (Array.isArray(r)) readyChips().forEach(function (c) { c.setAttribute('aria-pressed', r.indexOf(c.getAttribute('data-pready')) >= 0 ? 'true' : 'false'); });
      var t = JSON.parse(localStorage.getItem(KIND_KEY));
      if (Array.isArray(t)) kindChips().forEach(function (c) { c.setAttribute('aria-pressed', t.indexOf(c.getAttribute('data-pkind')) >= 0 ? 'true' : 'false'); });
      var sc = splitChip(), s = localStorage.getItem(SPLIT_KEY);
      if (sc && s != null) sc.setAttribute('aria-pressed', s === '1' ? 'true' : 'false');
      var fc = fillerChip(), f = localStorage.getItem(FILLER_KEY);
      if (fc && f != null) fc.setAttribute('aria-pressed', f === '1' ? 'true' : 'false');
      var q = localStorage.getItem(SEARCH_KEY);
      if (search && typeof q === 'string') search.value = q;
    } catch (e) { /* ignore */ }
  }

  // Active set for a chip group; empty (= none pressed) is treated as "no filter" by the caller.
  function active(chips, attr) {
    var set = {}, any = false;
    chips.forEach(function (c) {
      if (c.getAttribute('aria-pressed') !== 'false') { set[c.getAttribute(attr)] = true; any = true; }
    });
    return any ? set : null;            // null → group imposes no constraint
  }

  function apply() {
    var reads = active(readyChips(), 'data-pready');
    var kinds = active(kindChips(), 'data-pkind');
    var q = ((search && search.value) || '').trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (r) {
      // A pinned row (an in-flight decision being actively made) is still subject to the readiness/type
      // chips — it carries data-readiness="decision", so it stays visible by default and under the
      // Decision filter, but correctly drops out when you narrow to a readiness it isn't (e.g. Batchable
      // should show only batchable cards). Pinning governs ORDER (it's concatenated to the top), not an
      // unconditional filter bypass. Free-text search narrows it like any other row.
      var ok = (!reads || reads[r.getAttribute('data-readiness')])
            && (!kinds || kinds[r.getAttribute('data-kind')])
            && (!splitOn() || r.getAttribute('data-splittable') === 'true')
            && (!fillerOn() || r.getAttribute('data-lowprio') !== 'true')
            && (!q || (r.getAttribute('data-search') || '').indexOf(q) >= 0);
      r.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    if (countEl && table.prioLoaded) countEl.textContent = String(shown);
    // "Hide low priority" applies to the whole tab, not just the rows: swap every summary/section count that
    // carries a filler-adjusted variant (the section badge + the agent-ready pill's count & points) to its
    // no-filler value while the toggle is on, and back to the full value when off. Server emits both.
    var noFiller = fillerOn();
    Array.prototype.forEach.call(document.querySelectorAll('[data-pcount-full]'), function (el) {
      var v = noFiller ? el.getAttribute('data-pcount-nofiller') : el.getAttribute('data-pcount-full');
      if (v != null) el.textContent = v;
    });
    // Surface the empty-state when the filter hid everything (and keep it out of the way otherwise). The
    // row is appended after the snapshot in `rows`, so it's never iterated above or counted in `shown`.
    if (shown === 0) ensureEmptyRow().style.display = '';
    else if (emptyRow) emptyRow.style.display = 'none';
    // Every code path that changes chip/search state calls apply() afterwards, so this is the single place
    // to mirror the pressed state onto the chips and persist the whole filter.
    syncVisual();
    save();
  }

  // Summary count chips (data-pfilter) are one-click shortcuts that drive the readiness filter. Manually
  // touching a filter chip / search clears their "active" highlight so it never lies about the state.
  function summaryChips() { return Array.prototype.slice.call(document.querySelectorAll('[data-pfilter]')); }
  function clearSummary() {
    summaryChips().forEach(function (s) { s.setAttribute('aria-pressed', 'false'); s.style.boxShadow = ''; });
    var ss = splitSummaryEl();
    if (ss) { ss.setAttribute('aria-pressed', 'false'); ss.style.boxShadow = ''; }
  }
  function resetAllChips() {
    readyChips().forEach(function (c) { c.setAttribute('aria-pressed', 'true'); });
    kindChips().forEach(function (c) { c.setAttribute('aria-pressed', 'true'); });
    var sc = splitChip();
    if (sc) sc.setAttribute('aria-pressed', 'false');   // split defaults OFF (no constraint)
    if (search) search.value = '';
    // NOTE: filler ("Hide low priority") is deliberately NOT reset here. It's a VIEW-LEVEL control (it lives
    // by the section title and adjusts the summary pills, not just table rows), so it stays sticky across
    // facet operations — clicking a readiness/summary shortcut must not silently un-hide low-priority work.
    // Only an explicit full clear (the empty-state "Clear filters") resets it; see that handler.
  }

  // Delegate click to document (one listener for every chip, present or future) rather than wiring each
  // chip individually. A click on the wrapped inner <button> still matches here: the #2028 persistent-host
  // base copies data-p* attrs onto that child too, so closest() finds a match at the click target itself.
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-pready],[data-pkind],[data-psplit],[data-pfiller]');
    if (!t) return;
    table.withPrioRows(function () {
      t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') === 'false' ? 'true' : 'false');
      clearSummary();
      apply();
    });
  });
  if (search) search.addEventListener('input', function () { table.withPrioRows(function () { clearSummary(); apply(); }); });

  // The summary pills (data-pfilter shortcuts and the data-psplitfilter "N to split" pill) are
  // <we-filter-chip>s too — delegate on document (same reason as the readiness/kind/split chips above).
  document.addEventListener('click', function (e) {
    // The "N to split" summary pill — reset the groups to "all", then turn the split toggle on so the
    // table isolates exactly the split candidates (any tier). Clicking it again clears.
    if (!e.target.closest('[data-psplitfilter],[data-pfilter]')) return;
    table.withPrioRows(function () {
      var ss = e.target.closest('[data-psplitfilter]');
      if (ss) {
        var wasSplitActive = ss.getAttribute('aria-pressed') === 'true';
        clearSummary();
        resetAllChips();
        if (!wasSplitActive) {
          var sc = splitChip();
          if (sc) sc.setAttribute('aria-pressed', 'true');
          ss.setAttribute('aria-pressed', 'true');
          ss.style.boxShadow = '0 0 0 2px #334155';
        }
        apply();
        return;
      }
      var chip = e.target.closest('[data-pfilter]');
      if (!chip) return;
      var wasActive = chip.getAttribute('aria-pressed') === 'true';
      clearSummary();
      if (wasActive) {                         // clicking the active shortcut again clears the filter
        resetAllChips();
      } else {
        var cats = (chip.getAttribute('data-pfilter') || '').split(',');
        kindChips().forEach(function (c) { c.setAttribute('aria-pressed', 'true'); });   // readiness-only shortcut
        var sc2 = splitChip();
        if (sc2) sc2.setAttribute('aria-pressed', 'false');   // a readiness shortcut is a fresh view — drop the split facet
        // filler ("Hide low priority") is intentionally left untouched — a view-level control persists across
        // readiness shortcuts, so "hide low priority + show me decisions" keeps the low-priority items hidden.
        if (search) search.value = '';
        readyChips().forEach(function (c) {
          c.setAttribute('aria-pressed', cats.indexOf(c.getAttribute('data-pready')) >= 0 ? 'true' : 'false');
        });
        chip.setAttribute('aria-pressed', 'true');
        chip.style.boxShadow = '0 0 0 2px #334155';     // active ring, visible on every chip colour
      }
      apply();
    });
  });

  var hasSaved = false;
  try {
    hasSaved = [READY_KEY, KIND_KEY, SPLIT_KEY, FILLER_KEY, SEARCH_KEY].some(function (key) {
      return localStorage.getItem(key) !== null;
    });
  } catch (e) { /* storage unavailable */ }
  if (hasSaved) table.withPrioRows(function () { restore(); apply(); });
  else if (table.prioLoaded) apply();
})();
