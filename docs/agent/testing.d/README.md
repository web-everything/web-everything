## Testing topic notes

New testing notes are not appended to the shared guide: add ONE new file here
named `<topic>.md` with a first line `## Title`; never edit testing.md.
Use a descriptive kebab-case topic name in `docs/agent/testing.d/` so readers can
find it by browsing or searching. Refine an existing topic in its own file.
Do not edit other PRs’ fragments’ numbering. Numbered fragments preserve the
original guide order; new topic files remain unprefixed and sort after them.

Do not maintain a shared topic index: adding a note should touch only its own
file. The static directory link in `../testing.md` needs no per-topic updates.
The README is authoring guidance and is excluded from the joined guide.
Read all notes with `node scripts/testing-notes.mjs` from the repository root.

The join preserves all text and reports duplicate anchors separately. Resolve
reported anchor ambiguity before adding links; invalid fragment headings stop
the join. Three pre-existing duplicate topic copies are preserved losslessly.

Pinned incoming `testing.md#anchor` references have explicit destinations in
[the legacy anchor map](../../../scripts/__tests__/fixtures/legacy-anchor-map.json).
The [split baseline](../../../scripts/__tests__/fixtures/testing-notes-split-baseline.json)
pins every original section and the joined body with SHA-256. Verification reverses
only the recorded link relocations before hashing; it runs without Git history.
The separate history check fails if the pinned commit is unreachable; restore local
history or explicitly set `TESTING_SPLIT_BASELINE_SKIP=1` to waive that check alone.
