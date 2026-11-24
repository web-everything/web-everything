## PR1 audit: malformed rows, human holds and unavailable rosters

`pr-list-paged.test.mjs` pins success beside null, empty and unknown-type nodes in both
orders: mapping retains a nameless unknown row, marks the connection incomplete, and
prevents a green legacy summary (which rejects the malformed identity). Strict resolution
returns `unknown`. The open-PR fetch regression also proves that such an incomplete refresh
preserves an already observed failure. Retry the read on a later tick or inspect the evidence
before admission; never discard malformed nodes to obtain a green summary.

`check-state-predicate.test.mjs` requires the shared `humanReviewOnlyHold` guard for each
job/head-bound merge-gate hold source: IDs must be a nonempty subset of the human-review
hold gates and include `review-hold-labels` or `review-acceptance`. Candidate-label-only
and other incidental holds retain failure. Empty or malformed required rosters always
return `unknown` with `roster-unavailable`, including persisted options containing the
removed `allowEmptyRequiredNames` override and evidence with an observed merge-gate failure.
