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

The prioritisation table retains its loader (including the pending promise) on
the table across script reinitialization. Sort and filter handlers bind once.
`backlog-table-sort.test.ts` covers pending and completed loads, single sort and
filter actions after reinitialization, and retry after a failed load.
Happy DOM 12 does not implement `HTMLTableCellElement.cellIndex`; the table
fixture supplies a getter on its headers. Keep numeric and text columns with
different orders so sorting the wrong column or comparing empty values fails.

Restore saved controls and tile layout before starting fragment requests; a
failed request discards its completion callback. The retry regressions combine
saved preferences with a failed initial request and an explicit retry, checking
the restored search, facet, layout and visible result count. Table coverage also
checks repeated failures, script reinitialization, newer search edits and a retry
triggered by sorting. Apply filters when rows arrive so every successful loader
caller observes the restored controls.

After `build:docs`, the required CI smoke job runs the unchanged 24 MiB
deployment guard, then `node --test tests/build/site-asset-size.test.mjs`.
These post-build tests require `_site/backlog/index.html` and assert that both
the complete backlog page and every emitted asset are at most 20 MiB. They do
not skip missing builds. If the ceiling fails, inspect the reported assets and
reduce inline content or move it into bounded fragments before merging.
The workflow wiring is pinned by `backlog-prio-chunks.test.ts`; individual
fragment bounds alone cannot protect the complete rendered page.
The named default-limit test invokes the deployment CLI without a limit override
on sparse files: exactly 24 MiB passes, while one byte above and the reported
pre-fix 24.010340 MiB fail. It also pins the exported scanner's default; the
separate 20 MiB acceptance ceiling does not establish the deployment default.

`hotpatch-build-test-ci-definition` in `scripts/conveyor/soak/breaks/` replays
hotpatch admission with green CI and an own-sha audit. Full-build check edits
must still use the normal merge path, including after an unreadable path
snapshot recovers. The registry discovers this replay without an index edit.
