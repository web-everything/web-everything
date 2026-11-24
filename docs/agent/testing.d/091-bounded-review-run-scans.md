## Bounded review run scans

Review evidence scans stat candidates before parsing, read them by mtime descending (equal mtimes by
ascending id, for drain and recovery alike, so both read the same window), and parse at most `runs.scan.maxParses` (standard default 300) per read, including historical/recovery fallbacks.
The setting resolves through the shared standard/platform/tool cascade; `scripts/settings/runs-scan.json`
leaves the tool value unset so platform preferences apply. No environment override is added.
The shared finder continues from its cursor; it never retains a folder of payloads. Exhausting the
budget before completion returns `{ok:false, reason:"scan-capped"}` and logs the limit/source. The
enqueue gate, status labels and recovery scheduler hold on unknown evidence. A confirmed break
recorded in the PR's comments still takes precedence: the gate returns its send-back hold and the
status labels mark the PR `red-team:blocked`. Past the red-team deadline, unknown evidence never
counts as "no run": it is neither re-requested nor enqueued by the operator override, and it holds
with its reason named. Inspect omitted run
records before deliberately raising the limit. Genuine folder exhaustion still means no match.
Choose both head-specific and any-head matches by read-step `startedAt`, never file mtime.
A record is written after its read step starts, so its mtime is an upper bound on that start.
The scan therefore stops early, well below the cap, once every unread record was last written
more than 2 s (`RUN_MTIME_SLACK_MS`) before the exact-head match started: none of them can be a
newer run. A match whose start cannot rule out the omitted records still holds as `scan-capped`.
With no exact-head match in a capped window, a carried head still resolves through the any-head
query once the newest same-PR run started after every omitted record was written, and a head with a
status file also needs every omitted record written no later than that status. An unreviewed head
holds: past the cap, the absence of an exact-head run cannot be proven.
Recovery's carry fallback reuses the same scan, so one recovery read stays inside one parse budget.
When recovery's own exact-head query is capped, it reads that carry fallback before holding: a
carry the drain can settle from the scan is returned as carry evidence with no newest run (which
recovery never treats as owed); any other capped answer still holds as `scan-capped`.
Equal starts retain the drain's ascending / recovery's descending ID tie order. A start-less
same-PR run last written before the selected run started is older and ignored; any other start-less
run among two or more returns `run-start-missing` and holds. A single run needs no ordering and
remains usable without a timestamp. A newer unfinished attempt holds as `review-unfinished`.
A verdict-less run that run-store calls terminal (nothing pending or in flight) and that has not been
written for an hour (`ABANDONED_REVIEW_AFTER_MS`) is abandoned: it is neither evidence nor unfinished,
so a crashed re-review cannot hold a PR forever. A run waiting on a pending step or effect is never
abandoned, and neither is a rewound resume (`resumeOf`), which the review loop may still finish.
Unreadable records still throw, never skip.

Review discovery first tries the bounded `<runs-dir-name>-review-index.json` sidecar beside the
resolved runs directory. The run-store writer updates it fail-soft under a file lock; drain's complete
open-PR context advances persisted per-id verification (50 review records total per tick). Partial
backfills are staged, never published. Indexed payloads still pass the same PR/head, ordering and
unfinished-review checks. Missing/corrupt/unverified/overflowed hints take the original bounded scan;
`scan-capped` still holds. Indexed payload read attempts and the fallback share one
`runs.scan.maxParses` budget, including failed reads; cached indexed payloads count once.
Index bounds are 512 PR keys, 32 ids per key and 1 MiB per file. Per-PR
overflow becomes an empty sentinel, forcing fallback instead of silently discarding a review.
On a persistent backfill error or overflow, inspect omitted records manually; the index cannot clear
unknown evidence. The scoped regressions are `review-run-index`, `drain-red-team-evidence`,
`stream-filter-runs`, and the settings layout test `settings-files`; use heavy admission.


