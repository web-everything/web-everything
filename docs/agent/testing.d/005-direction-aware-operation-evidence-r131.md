## Direction-aware operation evidence (R131)

In-process review callers import the pure shape derivation from `scripts/lib/review-shape.mjs`.
Keep CLI evidence loading outside that module: unknown dynamic imports make daemon/promotion import
closures incomplete and force conservative restart, smoke and staleness fallbacks.

Shape shadow evidence must preserve every current file-only shape field. Pass hunks through the scorer's
`proposalDiffHunks` input so the proposal proves changes against the historical hold and sensitive hits;
clearing the hunk-aware gate alone cannot clear the proposal. Self-contained read-only import and registration
wiring can be proven; stored-array additions retain human review without consumer evidence, even beside
provable wiring. A harmless comment retains the hold with a `no new op reference` reason. Classifier
self-changes retain proposed human review even when the current gate did not fire.
Diff lines over 2000 characters require human review before parsing expressions.

PR-head modules are untrusted data: never import them into the reviewer process, even in shadow mode.
Read-only proof first requires an explicit IO audit in `read-only-ops.mjs`: only `heavy-queue`
and `pr-reconcile` are currently admitted. Compute-only declarations alone cannot prove purity:
injected IO can execute arbitrary commands, as `verify` does in run mode. Audit every mode before
admitting an operation; unaudited operations retain human review. The verify regression exercises
its real `createChecksRunner` with an injected spawn, then checks loader exclusion and live scoring;
a separate regression rejects another unaudited compute-only operation with complete byte evidence.
Proof also uses the reviewer checkout's registry and unchanged declaration plus every runner-imported `-io.mjs` module and their closures, regardless of operation name; new or
unreadable operations retain human review. `direction-aware-shape.test.mjs` probes a top-level host-write
attempt in native Node, dependency tampering, and live-mode holds on registry/step-kind changes.
An operation reference in hunk context never proves allow-list membership: moving a write-capable
import into `zeroWrites` beside a read-only addition must retain human review in live mode.
Standalone entries and complete named arrays retain human review: insertions can change positional or
length-based write guards regardless of an array's name, freezing, or neighbouring entries.
Total diff text over 200000 characters retains human review with an oversized-diff reason.
Removal matching consumes indexed normalized-text buckets while preserving same-hunk ordering.
Allow-list additions accept only balanced import/registration wiring or
balanced re-adds preserving a removed line's bracket counts and executable structure. Replacements
must be identical apart from indentation. Replacement evidence
must be the immediately preceding removed line in the same hunk; matching text elsewhere cannot
prove control-flow scope. The guard-relocation regression also pins the live-mode human hold.
Word conservation alone
cannot prove semantics: the guard-inversion-with-comment regression must retain human review. Other structural
lines retain human review, as does any net bracket-count change outside pure entries/wiring.
Every removed allow-list line also needs a distinct added partner in the same hunk, in removal
order, identical after stripping newly introduced op references from the addition and whitespace
and commas from both. Unpaired deletions retain human review; the scheduled-sweep quiet-hours
bypass and duplicate-guard regressions prevent borrowing another guard's replacement.
The health early-return bypass and removed-bracket regressions pin these fail-closed paths;
the #5961/#5962 fixture preserves the real import, registration and array-replacement shapes and retains
human review. Shape wiring tests separately exercise provable registration and stored-array holds in
shadow/live output, including event emission only when the current and proposed decisions differ.
Sandbox tokens anywhere in a hunk and hidden separators/control characters in protection additions
retain the hold. Missing/invalid tool mode stays shadow even when the platform requests live;
dependency proof checks regular-file sizes before reads, and shadow event logging waits at most 2s.
Review each "nearest", "only", and "never" qualifier in this document against a named test
that would fail if the qualifier were removed; prose qualifiers require review, not a deterministic gate.
The array cases cover complete, partial, positional and frozen lists. The shape tests
read the shipped settings with an empty environment and require shadow mode. Loader rejection
cases start with successful read-only evidence, then isolate missing trusted declarations,
incomplete dependency graphs, and the accepted 512-file / rejected 513-file boundary.

