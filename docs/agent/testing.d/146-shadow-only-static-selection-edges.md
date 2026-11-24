## Shadow-only static selection edges

`scripts/lib/static-selection-edges.mjs` measures comment-stripped imports, alias imports,
and literal spawn/read paths without changing gate selection. An optional `selectTests`
callback adds a `shadow: { tests, partial }` field; it never changes `mode` or the existing decision.
In `--measure` only, `WE_STATIC_EDGES_SHADOW` or `WE_DIFF_TEST_SELECTION=1` enables this
diagnostic and records `shadowEscaped` failures outside its test list. Each source has a
512 KB UTF-8 input cap: oversized files are skipped; oversized or unreadable evidence
sets `partial: true` only for changed files. Unknown files always widen static reach. Treat partial output as incomplete
measurement requiring inspection, never as proof of coverage or an input to a gate.
