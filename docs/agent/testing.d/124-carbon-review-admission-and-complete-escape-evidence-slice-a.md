## Carbon review admission and complete escape evidence (Slice A)

Carbon shadows require both `WE_REVIEW_SEAT_CAP_AGY_GEMINI > 0` and
`WE_REVIEW_SEAT_CAP_CARBON_SHADOW > 0` (default 1; malformed values refuse).
The daemon plist currently sets the Gemini cap to 0: operators must explicitly raise
it to enable Carbon shadows. A refusal records `agy-gemini seat cap 0` or
`carbon shadow seat off`; it never retries or reserves budget. Other Gemini models
retain their provider cap.

Non-shadow Carbon seats require `shadowSeats.antigravity.promoted === true`
(default false; environment `WE_REVIEW_SHADOW_AGY_PROMOTED=true`). Only the
orchestrator flips promotion after the manual ruling on ten agreeing PRs. The setting
resolves standard → platform review → tool review.json → environment and logs provenance.
The Carbon probation entry tracks shadow trials only; pinning Carbon never auto-seats
an advisory reviewer. Unpromoted non-shadow Carbon is refused, leaving Gemini unseated
by default. Historical counted-seat fixtures must explicitly supply promotion.

`review-shadow-model.test.mjs` covers both launch switches, malformed overrides,
manual promotion and the unchanged shadow path. `agy-review-juror.test.mjs` requires
`read_file` to name a nonempty direct string path under a path-like key, contained
by realpath in the juror lane (including symlink checks). Missing, scalar, array,
nested-only and escaped parameters void the run. Other read tools retain their rules.
Every nonempty transcript line must be an event object; an answered juror must end
with a `result` object whose status is `SUCCESS`. Empty, whitespace-only, unrelated,
non-object and incomplete transcripts void the run for incomplete escape evidence.
Successful fixtures supply realistic tool events and a successful terminal result;
never relax the evidence rule to accommodate an empty fixture. Refused evidence
requires a fresh run with a complete transcript before its answer can count.
