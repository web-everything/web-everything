## Backlog tile chunks

`src/_data/backlogTileChunks.js` owns the status-ordered tracked and resolved
selections, totals, inline previews and fragment manifests. Both inline and
paginated producers pass their item batch through `backlog-tiles.njk`, which
composes the shared badge macros before calling the real `weBacklogGrid` SSR
filter. Keep tile bodies in that include when adding tile content.

`src/_data/__tests__/backlog-prio-chunks.test.ts` renders the frozen current
corpus through that SSR path: it verifies ID parity, order, pagination URLs,
100-tile bounds and rendered bytes for both views without building the site.
`src/assets/js/__tests__/home-display.test.ts` covers deferred interactions,
saved preferences, totals, atomic failures and retry. Load state belongs to the
section so repeated script initialization shares the pending request. The
server total must survive until every fragment has been appended; filtering a
preview must never replace it with the preview count.
