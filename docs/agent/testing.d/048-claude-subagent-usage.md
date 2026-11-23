## Claude subagent usage

`node scripts/operations/agent-usage-report.mjs --session=<id>` extracts usage automatically from
Claude's persisted parent and child transcripts. Omit `--session` to use `CLAUDE_CODE_SESSION_ID`
with the cwd project slug; `--transcript=<parent.jsonl>` is the unambiguous cross-project form.
Run ingestion after the children finish: records are append-only snapshots, and a later scan of the
same agent does not update an earlier snapshot. This CLI does not install a scheduler or Claude hook.
It is suitable for a serialized session-end job; overlapping writers are not supported.

The script streams **every line** of each child, reusing `inspect-agent-health/agent-health.mjs`'s
project root, decorated-id handling and transcript resolver. `CLAUDE_PROJECTS_DIR` overrides that
root (set before module import). Sidecar `toolUseId` and parent `tool_result.tool_use_id` link the
actual `Agent` dispatch; structured `toolUseResult.agentId` or textual `agentId:` supplies the child
when the sidecar is absent. Task metadata prefers the sidecar description, then dispatch description,
otherwise null; raw prompts are never a fallback. Descriptions are capped at 200 characters, including
an ellipsis when truncated. Explicit child paths must resolve inside `PROJECTS_DIR` after symlink
resolution; outside paths (including sibling-prefix collisions) are rejected and counted in `skipped`.
The resolver compares against the physical project-store root while preserving `PROJECTS_DIR` for
diagnostics. ID-search candidates use the same containment check; escaping symlinks are skipped before
choosing the newest valid hit. Regression fixtures must include a deliberately symlinked store root:
realpath-normalized temporary roots alone mask mismatches between logical and physical paths.
Missing children and malformed transcript rows are counted explicitly.

The local sidecar is `.operations/agent-usage/<day>.jsonl`, covered by the existing `.operations/`
gitignore rule. Like `call-log-store.mjs`, its default root is the **script's checkout**, never cwd.
Separate physical lane clones therefore have separate defaults; set `OPERATION_AGENT_USAGE_DIR` to
one absolute directory to aggregate across them. Each timestamp day's `agentId` is the dedupe key;
no historical directory scan occurs on append. The first physical transcript line supplies the timestamp,
otherwise mtime does. For mtime-only transcripts, ingest after they stop changing so the day stays stable.

Records retain `task`, `modelTier`, `delegatedProvider`, `delegatedModel`, every `delegations` occurrence,
nullable `outcome`, `timestamp`/`timestampSource`, `agentId`, `sessionId`, transcript paths and `toolUseId`.
A single Claude model/provider is a string; multiple distinct models/providers are arrays so mixed runs
are not silently assigned to their last provider. `delegatedModel` is a `{command, model}` object, an
array for repeated invocations, or null for none. `delegations` additionally records the provider and
whether its model was explicit, the current script default, or unspecified. Codex's default comes from
its real exported `CODEX_MODEL`. Gemini's wrapper has **no pinned default**: it delegates model selection
to agy, so absent flags yield null, not a guessed model. The current Codex pin is a fallback inference,
not proof of the pin a historical checkout used.

Both command fields contain only the detected invocation's normalized argv, with content-bearing
`task`, `task-file`, `prompt`, `message`, `description`, `body` and `text` values replaced by
`[redacted]` (case-insensitive, both separate and equals forms). The result is capped at 300 characters,
including a truncation ellipsis. Shell wrappers and adjacent commands are not copied into this summary;
model extraction still uses the original parsed flags. Keep this transformation pure and redact before
capping: truncating raw content still leaks its prefix.

Only assistant `Bash` tool uses executing the named direct-task script count as delegation. The
conservative shell classifier understands literal script paths, node, common wrappers, shell `-c`,
quotes, comments, separators and heredocs. It does not evaluate shell variables, aliases or dynamically
generated commands. This counts recorded invocations, not proof that the external provider succeeded.
PR outcomes retain nearby text evidence for a created/opened/merged/rejected/closed PR or a bare PR URL;
these are best-effort transcript observations, not independently verified GitHub state or attribution.

`node scripts/operations/agent-usage-report.mjs --report --days=7` prints dispatch counts by exact
Claude model string, delegated provider and day. `--since=YYYY-MM-DD` is inclusive; `--days=N` includes
today in UTC. `--json` works in both scan and report modes. Each distinct model/provider observed in a
mixed dispatch receives one count, so category sums can exceed total dispatches. Missing models count
as `unknown`. Corrupt store rows are skipped and counted; scans also report corruption encountered in
target day files. Keep this unscored operational log separate from the committed delegation trial scorecard.

Tests under `scripts/operations/__tests__/agent-usage-report.test.mjs` create temporary project trees and
redirect the store. They exercise missing sidecars/children, full reads beyond the health helper's tail
budget, shell false positives, model changes, day rotation, reruns, corrupt rows and the actual CLI.

### Cross-clone numbering regression

`lane-drain-numbering.test.mjs` must exercise two separate repositories: a blocker numbered in
clone A, then a dependent landed in clone B with an empty local ledger. The shared `origin/main`
`bornAs` record supplies the fallback; local-ledger persistence alone cannot prove this path.
Unknown references report `in-flight` when a provisional item is visible in the checkout or a
local/remote branch tree, otherwise `unresolvable` (potentially dead, not proven dead: refs may be
unfetched). Dry-run returns the same diagnostics without changing numbering state. The fallback
visits explicit reference syntax, preserving bare birth-hash prose and `resolutionNote` quotes;
the older local-ledger blind-rewrite behavior is unchanged.

### Multi-repo check contract

`scripts/__tests__/multi-repo-checks.test.mjs` scans non-test JS/TS sources in
`scripts/conveyor`, `scripts/operations`, `skills-src/conveyor`, and `scripts/lib`.
The pure TypeScript-AST scanner ignores comments, checks repository scoping on gh
calls, and rejects duplicated constellation slugs. Specific exceptions live in
`scripts/lib/we-only-checks.json`; an exception with no remaining finding fails
with “remove this entry”. This is a Vitest contract, not a standards-gate rule.
The isolated parked-review workflow cannot import the shared table; its table is
pinned to `CONSTELLATION_REPOS` by `scripts/lib/__tests__/review-core.test.mjs`.

### Operator notification probes

Operator send-back regressions replay the whole PR thread, including a newer mechanical conflict bounce,
fix-end and advisory accept. `scripts/lib/operator-send-backs.mjs` owns resolution: trusted fix evidence must
explicitly name the request and a different head (short/full SHA spellings of the same commit do not count).
Acceptance labels alone never clear it. Evidence comments begin with a standalone `## Fix evidence` heading
or a standalone addresses marker (optionally preceded by `Head:`). Reviewer prose, blockquotes, fenced and
indented examples of those formats must never resolve a request, even from a trusted author. Keep evidence
markers in fixer prompts and replay quoted instructions through queue holds and verdict reduction. Verify the
complete comment reader retains URLs, and exercise planning, resumed prompts, review reduction, red-team
input fingerprints and both operator-queue entry paths. Unknown send-back heads remain open conservatively.
Partial operator-queue CLI copies load the send-back reader optionally, report import errors, and withhold
all readiness when it is unavailable. Notice retry receipts stay separate from thread-derived `noticedRungs`
and are scoped to the dispatch target, head and rung; a failed post must remain retryable.

`operator-notify` consumes only `operator-queue`'s `ready` rows. Tests inject the notifier,
including child CLI probes; never exercise real desktop delivery in this suite. Persisted
successes deduplicate until an item leaves NEEDS YOU; queue errors preserve all prior keys.
The operations IO fidelity gate requires the shared real-repo fixture even for filesystem
state: the notifier test proves its external state path leaves that checkout clean.

When spying on filesystem reads in a child process, reset observations after importing the
module and immediately before calling the operation. Node's module loader can use the same
filesystem API; including its startup reads makes bounded-read assertions runtime-dependent.

A core file that dynamically imports its CLI cannot await that import at module scope when
its CLI statically imports the core. A staged Node probe of that cycle exits 13 with unsettled
top-level await. Defer the import with `.then(...)`, and test both entry paths as subprocesses.

Keep the local admission heartbeat import graph free of remote CLI modules with top-level
await: terminating a watchdog worker during their evaluation can abort Node with SIGTRAP.
Load remote health only after selecting remote execution. The subprocess startup/stop case
in `scripts/__tests__/verify-lane.test.mjs` exercises that worker lifetime boundary.

### Daemon worker risk routing

For the [daemon model rule](../platform-decisions.md#daemon-claude-worker-risk), exercise
card loading through `readTick` and spawn argv: a pure router test cannot catch
`findItem` dropping frontmatter risk. Review daemon fixtures must inject both
`readPrs` and `readAgents` to exercise its shared PR snapshot; that snapshot carries
escalation reasons and touched paths into the session model selection.

### Explicit Claude spawn models

Operator rule (2026-09-29): every fresh daemon-launched Claude session must pass an explicit
`--model`; only `--resume` retains the existing session's model. `buildAgentArgv` refuses an
unresolvable model with `notApplied`. Its launch-kind table test covers every `LAUNCH_KINDS`
member, plus review/inspect, and the provider test checks that kind survives request narrowing.
Preserve routed choices; defaults use `workerTierFor` and `CLAUDE_SPAWN_MODEL_BY_TIER`.

### Automatic item-prepare retirement

Prepare claims reuse build claim locks and orphan PID classification, with the shared 15-minute heartbeat
TTL plus confirmed dead ownership (a known live worker still wins). Retirement reads the card from remote
main and checks this attempt's prepare PR; a failed read keeps the claim. Tests must cover stale run-store
rows and prior guards so a retired claim actually frees capacity. A completed unstamped result is held as
`prepare-unstamped`, including across daemon restarts and cooldown expiry; the hold clears when main carries
a valid `preparedDate`. An open PR's committed stamp is checked separately while it awaits landing.

Prepare result recovery: pass durable prepare holds into tick-core before candidate selection (including
its dispatch-lane re-read); filtering after its two-slot cap starves every later card. Held item guards
are excluded from capacity. Replay two held queue leaders plus two eligible successors. The daemon
uses `prepare-stamp-pending` for sectioned results and a detached lane worker to run `prepare-stamp`,
verify the committed stamp and submit via `open-pr --mode=label-on-green`; only missing sections retain
`prepare-unstamped`. Test fresh-main and existing-PR recovery, lane-local command paths, stale section
observations, resolved cards, failed stamps, freeze/dry-run, and a fresh Node `--bogus-flag` boot.

Duplicate-prepare guards must preserve recovery: cross OPEN/MERGED/CLOSED/no PR with main stamps,
sections and worker liveness in daemon-tick tests. An OPEN unstamped PR with a dead worker recovers
its stamp when sectioned and surfaces `prepare-unstamped` otherwise; a stamped OPEN PR awaits landing,
and a MERGED PR never triggers an unstamped retry. Keep replaced-stamp and live-worker cases pinned.
Offer two persistently refused candidates before a clean successor at cap two, across successive ticks:
refusals must not consume worker capacity. Missing, non-callable, throwing or malformed PR-list effects
must refuse dispatch. Reader integration fixtures must apply the actual search filters, including title-only
PRs outside `lane/`, `bornAs` branches, saturated shared listings, date-floor fallback and async prefetch.
Prepare launch fixtures, including grouped unit and soak scenarios, must supply `listPreparePrs: () => []`
when modeling no existing prepare PR; omitting the effect models an unavailable listing and refuses launch.
Every component search must be complete before its union can prove absence; cache by both identities.
When replacing a regression test, identify the replacement covering its original recovery behavior during review.


### Probation prepare validation and fallback

A prepare worker's clean exit is not a landable result. Require the substantive card sections, run
`prepare-stamp` in the acquired lane, and return a rejected stamp's diagnostic to the worker once
before abandoning. The #4325 regression produced 43 lines but lost them to the guarded writer's
locus-prefix validation; briefs must teach repository-prefixed code references. A no-diff result
must retain the worker's final explanation (#4322's old launcher log omitted it).

The build dispatcher reads durable `probation-launch` scorecard rows for WE `taskType: prepare`.
Two consecutive attempts without a PR activate `prepare-route-fallback`: subsequent prepares disable
probation and retain explicit Claude Sonnet argv. Re-reading history across ticks/restarts does not
reset this route; a newer successful probation prepare clears it. Test the diagnostic repair through
the parked-PR path, bounded refusal, and the daemon's dispatch environment as well as its route decision.

### Prepare launch evidence and brief boundaries

Standalone Claude prepares use `skills-src/conveyor/prepare-item-agent-brief.md`; probation's
runner reads `skills-src/conveyor/prepare-item-worker-brief.md`. Keep these separate: worker-only
instructions delegate stamping and publishing to a runner that standalone sessions do not have.
Dispatch success requires a persisted effect with a handle, never the planning verdict alone;
regress failed effects through the CLI reader and assert immediate claim release with the error.
Prepare retirement probes the worker handle independently of the daemon-owned claim PID.
A failed session listing remains unknown. The daemon's records live in the coordination
`build-dispatch-runs` store; scratch-started Claude transcripts live under dispatch project paths,
even after the session changes into a lane. Lane-only transcript searches miss those sessions.


### Builder postmortem accounting

Stream headless JSONL and match the first user message plus the dispatch attempt identity.
A session slug can be reused across attempts (observed for `conveyor-4341b`); join by
run/effect ID, worker UUID, implementation repo/lane and timestamps instead. Distinguish
preparation effects from build attempts: a `b` suffix alone does not prove a failed build.
Pair tool IDs and union their intervals before subtracting from wall time. Coalesce usage
by assistant message ID; split known external verify intervals from model/unobserved time
when a resumed transcript spans the gate. Tool `is_error=false` does not establish green
tests when output was piped through `tail` or a later report command succeeded. Intended
mutation RED runs and changed-input reruns are not waste. `lastSeenLiveAt` is not completion,
and `pr-opened` is not landed. Preserve unknown timings rather than converting them to zero.
The 2026-09-30 worked example and source offsets are in
`reports/2026-09-30-builder-postmortem.md`; operational metrics belong in the existing
`run-rating.mjs` / `run-scorecard-store.mjs` machinery, not a parallel history store.

