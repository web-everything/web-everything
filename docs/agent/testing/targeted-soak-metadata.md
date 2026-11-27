## Targeted soak metadata is untrusted source

Local verification must never import a target checkout's scenario modules. The
selector reads bounded source and accepts only declarative literal/const metadata;
methods remain inert. Imports are syntax only, never loaded. Executable top-level
statements, dynamic initializers, accessors, spreads, unresolved constants and
missing scenario test siblings refuse selection. Restore the sibling or rewrite
metadata declaratively, then rerun verification; a selector refusal cannot count
as green or reuse a default green cache. Explicit operator gate overrides retain
their existing provenance rules. The ruled over-budget merge-queue deferral stays
separate from incomplete evidence.

Keep temporary registries and markers under the task's TMPDIR. The audit tests in
`targeted-breaks.test.mjs` and `verify-lane.test.mjs` pin host-effect isolation,
non-execution of synchronous loops/descendant launches, missing-sibling cache
refusal and terminal red for incomplete selector evidence. Run these only through
heavy-admission. Bound failures must name a repair-and-rerun fallback.

Registry reads use a regular-file descriptor and request at most the smaller of
the observed size, per-file cap and remaining registry allowance, plus one sentinel
byte. Never replace that descriptor read with an unbounded read after a size check.
The growth-after-stat regression mutates a fixture between stat and read, forces
short reads, and checks byte counts, every requested range and descriptor cleanup.
