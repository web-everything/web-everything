## Main-red metrics

### Episodes and report

The pure exports in `scripts/conveyor/main-ci-red-core.mjs` validate and report
literal events. Nothing in the runtime imports these metrics exports or the
journal yet; the RED-METRICS-S3 planner will produce the events.

An episode begins with the first red observation while none is open. Its `since`
is `state.redSinceMs`, the first red run's `createdAt`, not `startedAt`. If a saved
proven-green time is later than that origin, the origin is unknown: use the poll
time and flag `truncated`. A probe window without a green run (`windowTruncated`)
also flags `truncated`. Only the first proven green with the same repo/seq ends
an episode. Unknown observations never close it, and later green events never
move a closed end. A repeated red start for a closed identity adds
`Incomplete episode identity: an episode start repeats a closed episode; recover archived evidence.`
and changes no minutes.

Events have exactly `v, key, repo, head, seq, runId, kind, at, since, queue,
signature, truncated`; queue has exactly `waitMs, serviceMs`. Extra properties,
including nested payloads, are invalid. Version is 1; `truncated` is boolean.
Signatures hash only structured job/file/test identifiers, normalizing whitespace
and slash direction. Controls, credential-shaped identifiers and oversized input
are refused; raw identifiers are never stored in a signature.

Reports use UTC and a half-open range `[from, to)`. Events at or after `to` are
ignored. Red minutes union `[since, end)` intervals per repo before summing and
splitting at UTC midnight; open episodes count through query time (clipped to
`to`). Queue wait is `startedAt - createdAt`, service is `completedAt - startedAt`.
Missing or reversed timestamps are unknown, never zero. There is no admission
wait metric because GitHub supplies no admission timestamp.

Queue samples are one per `repo:head:runId`, retaining the latest red/queue
observation before `to`. A pre-range sample counts only if its episode remains
open at `from` (`end === null || end > from`), determined after recovery replay.
A closed episode's pre-range red sample contributes neither queue timing nor a
signature observation. Signature counts are observations within `[from, to)`:
repeated queue observations count individually. Entries are
`{ signature, observations }`, with no `count` field.

Invalid ranges, ranges beyond 30 days, and scans beyond 10,000 events refuse with
empty days, zero open episodes, empty queue/signatures and a recovery warning.
Archive and replay smaller ranges; never silently truncate or tune policy from
incomplete evidence. Partial reports skip malformed/oversized events, keep the
first conflicting duplicate key, and warn. History beginning after `from`, green
or queue observations lacking an episode start, and truncated origins each warn
about incomplete evidence. Unknown observations and null queue waits warn about
unknown recovery/timestamps. Recover archived/source evidence before relying on
such a report.

### Journal

`scripts/conveyor/main-red-metrics-journal.mjs` stores one immutable JSON file
per event under the caller-provided `main-red-metrics/` directory. Its key names
the file; exclusive `wx` creation deduplicates concurrent writers and retries.
An existing key acknowledges only when every transition field agrees; only the
poll timestamp `at` may differ. Malformed, partial or conflicting winners refuse.

The journal allows at most 10,000 files and 8 KiB per event. Directory iteration
is bounded with one overflow probe; descriptor reads stop at 8 KiB plus one
byte. At capacity, existing matching events still acknowledge, but new events
refuse. Writers re-count after writes to detect concurrent overflow. Nothing is
deleted. Missing, malformed, unreadable, oversized or over-cap evidence emits an
operator-visible warning: archive the journal and replay a smaller range or
recover source evidence. Measurement failure is diagnostic only and grants no
alert, dispatch or merge authority.
