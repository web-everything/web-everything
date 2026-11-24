## Admission imports and daemon closures

Heavy admission is imported by review, promotion, self-sync and smoke machinery. A computed import
anywhere in its static closure makes those consumers fall back to treating unrelated code as relevant.
Keep the host-selected client loader command-only: `remote-client-import.cjs` is required lazily at
remote execution, outside that static closure and Vitest's ESM transform. Preserve the bundled client's
relative resolution when `clientPath` is unset. Location-only event consumers import `handoff-path.mjs`,
not the handoff CLI with its Git publishing dependencies; the CLI re-exports the same path function.
`heavy-admission-import-boundary.test.mjs` proves the complete closure, actual bundled execution for
unset settings, lazy adapter loading in native Node, and real override event/provenance writes.
Run it alongside the remote-client, daemon closure/staleness, live-smoke and shape wiring regressions
through the host heavy-run queue; do not weaken their complete-closure assertions.
