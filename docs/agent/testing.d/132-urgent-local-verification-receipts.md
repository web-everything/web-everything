## Urgent local verification receipts

FUI sibling verification requires its origin to normalize to `https://github.com/frontier-ui/frontierui`
(HTTPS and Git SSH forms are accepted) before fetching or installing. Signed receipts bind `fuiRepo`
as well as `fuiSha`; old receipts without the origin require fresh verification or passing CI.
The urgent sweep reads all check-runs (maximum 100, exact count and unique IDs required) and settles
green only after every run completes and all required runs succeed. Pending unrelated runs keep the
load eligible for later failure detection. Legacy green settlements without `checksComplete: true`
are rechecked; incomplete or oversized evidence escalates to NEEDS-YOU for manual inspection.
Malformed, incomplete, oversized or duplicate-ID evidence never authorizes CI-failure unloading, even with a possible bound failure. Escalate that possible failure once per tracking ID and keep monitoring; the 24h verdict expiry still unloads.

Urgent verification mirrors CI coverage artifacts under ignored `coverage-shards/`; clear this directory before a run and copy each covered shard before the next overwrites its report. Receipts require the runner-owned private HMAC key and the loading checkout’s normalized origin. A completed failing CI gate always refuses urgent loading; old unsigned receipts require a fresh verification or passing CI.

The urgent gate mirror pins every `run` text in `test-shard`, `coverage-merge`, `host-paths`,
`integration`, `test`, `standards` and `changes`, with job-specific setup commands and exact occurrence counts.
Extra validations require a local runner update, including otherwise familiar setup commands.
Checkout sources and paths are pinned: WE uses the event checkout without a ref/repository override; FUI uses `frontier-ui/frontierui` without a ref override. When CI adds
validation, update the mirror before issuing local receipts; unknown run steps refuse with
`unreadable-ci-gates`. Keep the real-workflow acceptance and per-job unknown-step regressions
in `urgent-verify.test.mjs`.


Urgent verification derives the required CI job closure from `test.needs`, including transitive
dependencies; unknown jobs or changed install commands require a mirror update or passing CI.
It verifies the clean FUI sibling against its fetched default branch, then admits FUI install/build
and checkout install before suites. Signed receipts include `fuiSha` and both install steps; older
receipts require fresh verification. Child environments are allowlisted with CI markers explicitly removed so host admission cannot be bypassed, and the signing key is read
only after the suite pipeline stops. `urgent-sweep` is one bounded pass (32 loads, 100 checks per SHA);
the orchestrator schedules it. Its durable settlement ledger prevents repeat handling and stores a
`sweep-cursor` before each batch so pending or unreadable loads cannot starve later entries.
Cursor records never settle a load; older ledgers without a cursor start at the beginning. Completed
failures in any check-run on the SHA, regardless of job or app, open a once-per-tracking-ID NEEDS-YOU escalation through
`land-advance-escalations`; unreadable/oversized evidence and legacy records without registrations
require operator repair or manual unloading. Settlement identity includes the load tracking ID, so a reload
starts fresh. Check failures authorize removal only for the GitHub Actions app and jobs in the configured
`test` needs closure, with each suite bound to that workflow run on the exact SHA. Validate complete,
bounded check pages before acting. Select only the latest check ID per app, check name and suite (including workflow rerun attempts), as in `testCheckEvidence`; a newer success supersedes its own older failure, while another suite or shard cannot.
Unrelated app/workflow/job failures never authorize removal or green monitoring; they remain tracked
with a durable failure-escalation receipt. The 24h verdict expiry still permits unloading.
Unknown workflow or required-job
evidence stays tracked and requires operator inspection; the existing verdict expiry still applies. Green loads are checked every pass while their clone/ref remains in the shared overlay
store, including historical time-complete receipts. Only confirmed absence ends monitoring; corrupt
overlay state escalates and stays tracked. A failed registration command can leave a persisted overlay:
the loader writes a registration-failed note only after the shared overlay reader proves clone/ref
absence, and the sweep honors that note only after confirming absence again. Present or unreadable
registrations retain monitoring. Keep these paths in `prototype-load.test.mjs` and `urgent-sweep.test.mjs`.

Action signatures also pin exact `if`, `env` and `continue-on-error` values, including their absence.
A changed checkout condition or action environment refuses with `unreadable-ci-gates`; update the
mirror or wait for passing CI. The real workflow and every action's context mutations are covered
in `urgent-verify.test.mjs`.

Urgent retirement requires both the matching load and a persisted `unload-decision` from
`urgent-sweep-state`, read under the overlay lock. The sweep writes this decision before removal;
write failure leaves the registration intact. Decisions bind tracking ID, clone, source ref/SHA
and registration ref/SHA, with either an exact-source-SHA completed failure or a `ci-expired`
decision at least 24 hours after loading. A load record alone never authorizes withdrawal.
Urgent withdrawal reuses explicit `--remove`'s `proveOverlayWithdrawal` guard under the add lock:
cached stacked dependents or live ancestry to another registration refuse removal. Unreadable
dependent evidence also refuses; inspect the stack before unloading manually. Fetch the target
as well as each potential dependent before comparing ancestry: urgent clones may lack the target's objects.
Missing, unreadable, mismatched, future or incomplete decisions refuse; inspect CI and repair the
ledger or unload manually. The production decision reader shares the 4 MiB ledger bound and
archive fallback. Decisions are authorization records, not unload settlements: refused removals
retain the decision without emitting an unload event. Historical settlements retain their existing
adoption handling. Keep these guarantees in `urgent-sweep.test.mjs` and
`daemon-overlay-replace-retire.test.mjs`.

The CI mirror also pins each run step's directory, environment, shell, condition and error policy,
and refuses job run defaults, environments and containers. A context change requires updating the
mirror or waiting for passing CI; command equality alone cannot authorize an urgent receipt.
Health-watch schedules `urgent-sweep-tick.mjs` every five minutes, persisting `urgentSweep.lastAttemptAt`
even on failure. `scripts/settings/urgent-sweep.json` controls the interval through the policy cascade
(`WE_URGENT_SWEEP_INTERVAL_MINUTES` is the environment override). Fixture, redirected and dry-run ticks
skip host urgent loads. Errors are logged and recorded as probe errors without interrupting the tick.
Keep cadence, persisted-stamp and fail-soft wiring regressions in `urgent-sweep-tick.test.mjs`.
The lane-scan boundary guard also pins `runUrgentSweepTick` by module/export identity and exactly one
health-watch invocation. Keep sweep IO in the tick module and register new reviewed tick entry points
in both helper inventories without exempting them from the call-site guard.

Absent registrations removed by another actor also require ancestry proof: settle only when HEAD
excludes the urgent SHA or a freshly fetched `origin/main` contains it. Historical
`settled-unregistered` receipts without `ancestryVerified` resume monitoring. Persist the first
observed absence in `monitoring-unregistered`; while unmerged code remains in HEAD, keep reading
CI and raise one NEEDS-YOU per tracking identity on failure or after 15 minutes. Unloading an
already absent registration cannot repair that running build. Unknown ancestry/fetch evidence
escalates and stays tracked. The urgent sweep suite pins both settlement proofs, grace/deduplication,
later CI failure, legacy receipt migration, and bounded injectable Git IO.

