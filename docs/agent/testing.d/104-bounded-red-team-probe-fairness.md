## Bounded red-team probe fairness

`scripts/lib/__tests__/red-team-dispatch-queue.test.mjs` pins a default of six probes per
repository per tick and a hard ceiling of 50. Invalid caps (including strings, fractions,
negative values and values above 50) use six; see `invalid configured cap %s falls back
to six actual probes` and the `invalid probe cap` cases for file, operator and direct input.
An unreadable or invalid operator policy uses the stricter of the valid file cap and six
(invalid or missing file caps count as six), while disabling capacity raises. See
`unreadable operator store restricts file cap %s to %i actual probes`.
Unreadable/unparseable settings files and a throwing floor loader still disable probes;
see `%s settings disables probes and logs settings unreadable loudly` and
`a throwing floor loader fails closed to zero probes, never the default six, and logs loudly`
in `skills-src/conveyor/__tests__/review-daemon-red-team-floor-refresh.test.mjs`.
The valid operator `redTeamQueue.maxProbesPerTick` leaf overrides the settings-file value.
Zero explicitly disables probes. Historical
two-probe rotation fixtures explicitly set their cap to two. The tests also pin
least-recently-probed turns persisted as optional `lastProbeTurn` entry fields.
Keep historical entries without the field loadable, reject malformed turns, and
exercise five still-blocked entries across three ticks with a reload between ticks.
Probe selection must preserve runnable FIFO admission and distinguish waiting for
a probe turn from disabled probes and runnable capacity holds.
Newly blocked entries (including runnable entries with an old turn) must join the
tail using the same overflow rebase as probe admission. Keep a probe's current turn
when it stays blocked. Replay two new planner skips per tick alongside four blocked
heads across restarts, and bound repeat probes by `ceil(blockedCount / 2)` ticks;
new arrivals must never overtake heads already waiting in the rotation.

The queue regression and `red-team-queue-stale-eviction` soak break replay live-state
maintenance across restarts. Terminal PRs are evicted even when stale planner candidates
still list them. Changed live heads are re-keyed in place with attempts and blocks reset;
unreadable evidence keeps entries, logs the failure, and defers admission. Reconciliation
runs inside the dispatch transaction so a thrown runner rolls back eviction and re-keying.
Planner skips retain the existing bounded, fair probe rotation.
Partial inventories never sync, enqueue, evict or re-key candidates: only known blocked
entries with a live OPEN read matching the stored head may be probed, using head-bound
refusals and raw PRs from those reads. Runnable entries wait for a complete inventory.
Only the PR reader's inventory or truncation errors enable this recovery; other failures skip it.
The `red-team-probe-cap-starvation` soak break reopens ten blocked entries between
ticks and requires multiple probes in one tick and all ten within two default ticks;
its `fixPresent` presence probe matches source text only. The separate `run()` scenario
executes queue behavior, including invalid-cap fallback and partial-inventory safety.
Presence detection alone is not evidence that the behavior works.

Acceptance claims must name a repository-qualified test file, case and expected assertions.
When documenting an invalid-input default, link the case that pins the actual fallback.
For this probe-cap change the mapping is:

| Acceptance | Contract test and assertions |
| --- | --- |
| Cap 10, absent cap, invalid caps, cap zero | `scripts/lib/__tests__/red-team-dispatch-queue.test.mjs`: `%s setting 10 probes all ten blocked entries in one tick`, `setting absent defaults to exactly six probes among ten blocked entries`, `invalid configured cap %s falls back to six actual probes`, `%s setting 0 disables probes and retains blocked entries`; assert actual probe identities/counts and retained membership for zero. The `invalid probe cap` group also covers raw/direct inputs. |
| Unreadable operator policy | Same file: `unreadable operator store restricts file cap %s to %i actual probes`; assert zero stays zero, three stays three, ten/fifty become six, and both capacity raises stay disabled. |
| Partial inventory | `skills-src/conveyor/__tests__/review-daemon-partial-list-red-team.test.mjs`: `partial inventory probes only live matching blocked heads while retaining entries and refusing unknown and draft PRs`; assert exact probe identities, matching raw heads, unchanged queue membership/head/attempt state and exclusion of closed, changed, unreadable, runnable and unknown PRs. `partial inventory host admission fails closed when %s` covers denied, null and throwing host reads; `partial inventory paused ticks retain all entries without probing` and `other list failures do not enable partial inventory probing or enqueue unknown PRs` pin the remaining guards. |
| Two default ticks over ten synthetic heads | `scripts/conveyor/soak/breaks/red-team-probe-cap-starvation.soak.test.mjs`: `ten blocked red-team heads receive probe turns within two default ticks`; `run()` requires all ten identities across persisted reloads. This does not establish production timing. |
| Live PRs after load | **PLANNED, not executed:** `specified accepted PRs receive head-bound probes within two post-load daemon ticks`, described below. |

The deployment verification `specified accepted PRs receive head-bound probes within two
post-load daemon ticks` is required after load. Record the deployed revision and UTC load
boundary, then the start/end boundaries of the first two complete review-daemon ticks for
`web-everything/web-everything`. Record each live head SHA for #7155, #7153, #7158, #7156,
#7149 and #6945 at load. By the second tick's end, require a queue `probe` log with that
PR identity and `head=<sha>` for every one of the six. Record the tick index and UTC probe
time for each identity; missing probes, missing boundaries, changed heads or unreadable
evidence leave the check unverified and require a new observation window. Save the six-row
record with the PR's fix evidence. A synthetic soak pass cannot satisfy this live check.
The `red-team-queue-verdict-evict` break also replays decided-head eviction: use
`isPublishableRedTeamResult(redTeamForHead(...))` over complete trusted comments,
then require readable carry/status/outbox evidence with no settlement owed and a
confirmed completed check (success or failure). Missing checks, unfinished carries,
unpublished carried checks, pending labels and unreadable evidence keep recovery queued.
Readable live fixtures must supply `comments: []` when no result exists; missing
comment evidence retains the entry and defers admission. Decided heads must stay
evicted when stale planner candidates return, including the card-only bypass.
Run the soak `.soak.test.mjs` with `--config vitest.soak.config.ts` through heavy admission.

