## Fast-drain live proof

Use this procedure for FASTDRAIN-SELF-REFRESH-HARDEN S6. Unit tests do not
replace the S3 throwaway-PR proof that label add, label removal and body edits
each change `updatedAt`. Record before/after timestamps for each edit before
running the live load experiment. A failed observation stops the experiment.

Start a three-hour window at a recorded UTC timestamp. At three hours, finish
only if at least 30 children have complete pairs; otherwise extend the same
window to six hours. Fewer than 30 pairs at six hours is INCONCLUSIVE. Do not
restart the window or select a faster subset. Include every paired child,
including errors and timeouts. Report unmatched starts/exits at both edges.

Pair by repository, daemon boot identity, child PID/start identity and PR
number, never PR number alone. Preserve rotated logs and record boot boundaries
so a daemon restart cannot pair an old start with a new exit. If logs lack
enough identity to disambiguate concurrent children, report INCONCLUSIVE.
Use the child's logged elapsed time; for a timeout use that child's effective
`mergeQueue.enqueueOnEvent.timeoutSeconds` and its logged setting source.
Missing configuration or ambiguous pairing cannot supply a passing sample.
Sort elapsed seconds and take index `ceil(0.95 * count) - 1`. PASS requires
p95 below 60 seconds, zero incomplete-context or unclassified errors, all
outcomes in O1–O10, and at least one between-pass enqueue confirmed by a live
`isInMergeQueue` read. Unknown outcomes or defer reasons fail the experiment.

Audit each child's writes using a child-specific correlation record containing
repository, target, judged head, boot identity, PID and start/end timestamps.
Collect mutations by the drain identity across both WE and Frontier UI,
including non-target PR timelines, comments/labels, queue membership changes,
branch/ref pushes and workflow-run cancellation/rerun/delete operations.
Compare every observed mutation with that child's `fast-drain write:` record
and the enqueue-only allowlist. Shared identity and overlapping time windows
alone do not establish attribution: unresolved attribution is INCONCLUSIVE.
Any non-target or forbidden mutation is FAIL, including detached followups.
An unavailable audit source is incomplete evidence, never an empty write set.

Before admission a failed validator permits only the explicitly listed
hold-only writes. After admission, enqueue must pin `expectedHeadOid`;
clearance and ledger writes require confirmed membership at that head.
Report the two accepted races separately: rules/workflow/evaluator changes
after the child-start precondition, and red-team results after the final
validator. Do not claim the experiment closes either race.

CLI admission fixtures must publish an identity index for every canonical
constellation repository, including empty siblings. Owner-derived sibling slugs
alone omit Frontier UI and plateau-app when the target uses the canonical WE
slug; that exercises `index-age`, not the intended downstream validator.
The live target's optional `targetMaxAgeMs` bound remains separate from index
provenance: reuse its original observation timestamp and perform a real second
read when inventory construction outlives the bound.
