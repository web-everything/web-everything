## Expectation babysitter replay (S1)

`stuck-prs.test.mjs` tests the separate observe-only detector through heavy admission.
Its captured sweep daemon lines are fixtures, not live-head attestations: R-d requires
an explicit current-head binding; the original unbound #7112 human-hold line stays
unknown. The CLI reads one open-PR batch and 8 MB log tails. Tail/list caps warn the
operator to inspect omitted history/PRs. NEW-cause receipts reserve before append;
failed appends, abandoned locks and capped receipts require manual inspection.

Run `npm run test:unit -- scripts/conveyor/__tests__/pr-expectations.test.mjs` through
heavy admission. Replays require all three scratch paths: `--events-file`,
`--evidence-file`, and `--state-file`; `--as-of` requires those paths too. The events
file is both input and the scratch miss-event sink. Evidence fixtures use the
explicit head-bound contract documented in `pr-expectations.mjs`. Missing or capped
evidence remains unknown. Miss receipts reserve before append to prevent duplicate
emission after restart; a failed append or abandoned lock requires operator inspection.
Delivery is at most once, so a crash after reservation but before append can lose a
miss event. Failed reservations never append; successful appends followed by a save
failure never retry. The fault-injection tests pin both boundaries and the event's
complete facts/response contract. Live logs use a 16 MiB tail, skip an unfinished
last append, and retain observed current-head actions in state across log rotation.
Malformed complete lines still make evidence unknown. Historical PRs outside the
open/tracked set are ignored; terminal PRs retire after a complete evaluation.
Existing queue entries suppress enqueue timers, including after a dequeue/requeue.
The `expectation-live-event-history` soak replays producer events through the live pass.
The `expectation-check-verdicts` soak checks that a completed head-bound red-team
check settles its verdict after the pending label clears, while unit and review-gate
checks leave review-started unmet. Unit regressions cover every accepted completed
conclusion, review-gate name variants, and a real review dispatch as a positive control.

