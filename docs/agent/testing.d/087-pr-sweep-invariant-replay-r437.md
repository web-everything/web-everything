## PR sweep invariant replay (R437)

`scripts/conveyor/__tests__/pr-sweep.test.mjs` covers the all-open-PR shell, state clocks
independent of `updatedAt`, dependency ordering, and alert-backoff migration. Backoff is
explicit in `prSweep.alertBackoffMinutes`; omitted settings retain legacy one-shot callers.
Dependency annotations are report-only and scoped to one repository. Markdown quotations,
fences and inline code do not create dependency edges. The four incident shapes are replayed
with injected readers in `pr-sweep-invariant-four-cases.soak.test.mjs`; run that file with
`--config vitest.soak.config.ts` through heavy admission (the unit config excludes soak files).

PR dependency edges require the target in the same repository's current open-PR listing.
The named blocker-removal regression in `pr-sweep.test.mjs` keeps the textual annotation
unchanged while removing the target, then proves the dependent regains a stall episode and alert.
The named cross-repository number-collision regression lists the same dependent number in
two repositories, with its blocker open only in one and absent or merged in the other.
Both listing orders must preserve the other repository's stall episode and eventual alert.
Its same-repository control uses
`Blocked by: #6244`; dependency phrases accept an optional colon, still excluding quoted
examples and references split across lines.

`prSweep.deadlineMinutes` accepts either a positive scalar for every action budget or a
per-action map. The settings-to-evaluator contract cases in `pr-sweep.test.mjs` exercise
both shapes from tool and environment settings, including effective deadlines and provenance.

When the invariant digest producer is enabled, its owner-signal failures must mark the shared digest incomplete.
`pr-stall-digest.test.mjs` exercises the real sweep and feed publisher across an owner-read
failure, recovery, and a later confirmed PR removal: incomplete evidence preserves the open
invariant item, while a complete listing may clear it.

Dependency extraction uses Markdown block structure to exclude indented code and lazy
blockquote continuations as well as fences; inline code retains the conservative exclusion
for unterminated spans. The indented/quoted-example sweep regressions prove these examples
cannot suppress a stall episode. Empty diffs take precedence over dependency waits in the
action, deadline, violation, legacy report, and digest while preserving dependency metadata.
The four-case soak keeps a live blocker on its empty-diff fixture to pin that precedence.

Legacy sweep/detector rows retain their original shape unless dependencies, empty-diff
precedence, or configured alert backoff require enrichment. New invariant rows carry their
own metadata; the feed serializer omits extensions absent from a legacy item. An explicit
sweep-off or digest-false pass preserves detector-only behavior: agent listing failures do
not make the independent detector incomplete, while enabled invariant producers still
preserve published items when ownership cannot be read.

The named `mode=off`, `digest=false`, and `enabled invariant producer` cases in
`pr-stall-digest.test.mjs` seed a real detector feed item before an owner-read failure.
With independent PR/detector reads succeeding, the disabled producers allow complete
passes to clear the stale item; the enabled producer preserves it as incomplete evidence.
The tests also require the detector digest to remain enabled, excluding disable-time
clearing as a false-positive proof of detector completeness.

