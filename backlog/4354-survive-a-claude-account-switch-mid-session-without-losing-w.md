---
bornAs: xlou1je
kind: story
size: 8
status: open
scope: ["we:scripts/lib/lane-lease.mjs", "we:scripts/lib/lane-hold-io.mjs", "we:scripts/lane-pool.mjs", "we:scripts/conveyor/lease-reaper.mjs", "we:scripts/lib/account-identity.mjs", "we:scripts/operations/worker-launch-record.mjs", "we:scripts/operations/resume-report.mjs", "we:.claude/settings.json", "we:.claude/commands/continue.md", "we:docs/agent/dispatcher-runbook.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec"
tags: []
---

# Survive a Claude account switch mid-session without losing work

2026-09-28 ~11:30 AM ET: the operator switched Claude accounts mid-session. The orchestrating session resumed fine (its transcripts are local), but its 3 in-process background workers stopped with no completion record, and 2 of them lost their we:scripts/lane-pool.mjs leases while holding uncommitted/unpushed work (lane-5: 1 unpushed commit + scratch; lane-8: 6 uncommitted files) that we:scripts/conveyor/lease-reaper.mjs could instead have reclaimed and reset. One worker's follow-up commit never reached its own PR and had to be rescued by hand from the abandoned lane's object store. Separately, the iOS Code tab was slow to surface the resumed session, and daemons silently run as whichever account the CLI happens to be logged into, with no visible record of which account did the work. Ask: (1) make a lane lease survive its owning session stopping by tying it to the lane's actual content (commits/diff), not only the live process, so a stopped worker's work is never silently orphaned; (2) a resume checklist/command listing stopped workers plus each one's lane state (clean/committed/pushed); (3) a documented, checkable note on which account each daemon authenticates as.

## Evidence (2026-09-28 ~11:30 AM ET)

- (a) the orchestrating session's 3 in-process background workers were stopped by the account switch with no
  completion record anywhere the resumed session could read.
- (b) two of them held live we:scripts/lane-pool.mjs leases with real unpreserved work when they stopped —
  lane-5 (1 unpushed commit + scratch) and lane-8 (6 uncommitted files) — which we:scripts/conveyor/lease-reaper.mjs
  could have reclaimed/reset instead of leaving to go stale or be hand-rescued.
- (c) one worker's follow-up commit (registering the #4337 soak break) never reached its own PR (#2841, merged
  without it) and had to be cherry-picked by hand out of the abandoned lane's object store before it was reset
  out from under this task — see the sibling rescue in this same PR.
- (d) the iOS Code tab took a noticeable while to show the resumed session.
- (e) daemons authenticate as whichever account the CLI (`gh`/`claude`) is currently logged into
  (we:scripts/lib/github-app-token.mjs) — an account switch changes who a daemon acts as with no visible signal.

## Asks

1. A lane lease that survives its OWNING SESSION stopping — tie the lease's liveness signal to the lane's own
   content (has it got commits ahead of origin? uncommitted changes? scratch?) rather than only to whether the
   spawning process/session is still alive, so we:scripts/conveyor/lease-reaper.mjs (and the acquire-time
   backstop in we:scripts/lane-pool.mjs) never treats "session gone" as "safe to reap" when real work is sitting
   there unpushed.
2. A resume checklist/command: on `/continue` (we:.claude/commands/continue.md, backed by
   we:scripts/operations/handoff-home.mjs) or an equivalent fresh-session entry point, list every background
   worker the prior session had in flight, whether it's still alive, and — for each one holding a lane — that
   lane's state (clean / uncommitted / committed-unpushed / pushed). Today a resumed session has no way to learn
   this short of manually walking `we:scripts/lane-pool.mjs status`/`list` and guessing which lanes are its own
   orphans.
3. A documented, checkable note on which account each daemon runs as (surfaced from
   we:scripts/lib/github-app-token.mjs / `gh auth status`), so an account switch is visible instead of silently
   changing who a daemon acts as mid-run.

## Risks

- Ask 1 must stay fail-closed in the SAFE direction only: broadening what counts as "still live" must never let
  the reaper miss a genuinely dead, empty lane it safely reclaims today — it should only make it MORE reluctant
  to reap a lane carrying real unpreserved content.
- This is exploratory: none of the three asks has a chosen mechanism yet, so this card intentionally does not
  prescribe one (e.g. "poll the CLI's active account on an interval" vs. "stamp the account into the lease at
  acquire time" are both live options for ask 3).

## Ruling (operator, 2026-10-09 ~13:05 ET)

The open choice from the prepare run (how a resumed session learns which background workers were running) is
ruled **(c) both**:
- **Source of truth: a launch record.** A hook on the agent-launch tool writes each background worker's id,
  purpose, lane and session to a durable record at launch. No caller discipline; the hook does it.
- **Fallback: reconstruction at resume.** The resume command also walks lane leases and lane content-state and
  lists any lane with no matching launch record, so workers started before the hook (or outside it) are not lost.
- Unchanged and not in question: the lease reaper never reclaims a lane carrying unpreserved work (ask 1, safe
  direction only).

## Progress

- 2026-10-09 prepare pass. **Premise check:** not delivered. `git log` for `4354`/`xlou1je` shows only the filing and the ruling commits. Since filing, the lane-hold rule (#xbdixjc, PR #4508) landed: `we:scripts/conveyor/lease-reaper.mjs#applyLaneHold` (line 1166) now keeps a reap candidate whose lane is awaiting verify, verifying, or holds a verified-unpushed commit. That covers only lanes that have a verify record. A lane with an unpushed commit or uncommitted files and no verify record still reads "no hold signal" (`we:scripts/lib/lane-lease.mjs#laneHoldVerdict`, starts line 648, ends in `allow('no hold signal')` at line 676), so the reaper still releases it with `--force` (`we:scripts/conveyor/lease-reaper.mjs#releaseLane`, line 1420). Lane-5 and lane-8 in the incident were exactly this shape. A release drops only the marker; the work itself is then lost only through a later `--force`/`--override` acquire or a hand reset, because a plain acquire still refuses a dirty or ahead lane. The hold closes the marker-drop step that makes those paths reachable and invisible.
- **Review round 1 (adversarial subagent), addressed below:** release call site passes a boolean that skips the work read; stale remote refs would cause false holds; launch-record join ambiguity (in-process workers share the parent's session id); hook timing for foreground launches. Dismissed with reason: "held lanes leak forever, so auto-salvage is a Must" — the ruling says the reaper never reclaims unpreserved work, a held lane is visible in the resume report and costs pool capacity, not work; how long "never" lasts is an operator call, so it stays a Follow-up (stated as a known cost in Design A).
- **Scope drift corrected:** the old scope listed we:scripts/conveyor/session-reaper.mjs, we:.claude/commands/handoff.md, we:scripts/operations/handoff-home.mjs and we:scripts/lib/github-app-token.mjs; none needs an edit (the session reaper stops sessions, not lanes; the handoff files are not where launch records go; the GitHub App token mints App identity, not the CLI login the incident is about). The new scope adds the files the mechanism actually touches: we:scripts/lib/lane-lease.mjs, we:scripts/lib/lane-hold-io.mjs, three new modules, the hook registration, the runbook. `size:` stays 8 (three slices, about ten files; the build may ship them as ordered commits A, B, C).
- **Ruling honoured:** ask 2 follows the 2026-10-09 ruling (c): hook-written launch record as source of truth, lease/content reconstruction at resume as fallback.

## Design

Three slices, each independent, ordered by risk.

**A. Content-aware lane hold (ask 1).** The rule already exists and already runs in both the reaper and `release` itself: `we:scripts/lib/lane-lease.mjs#laneHoldVerdict` (line 648), reached through `we:scripts/lib/lane-hold-io.mjs#checkLaneHold` (line 102), called from `we:scripts/conveyor/lease-reaper.mjs#applyLaneHold` (line 1166) and from the `release` command in we:scripts/lane-pool.mjs (line 2721, `laneHoldRefuses`). It holds only on verify/await signals. Add one more signal: a new fact `work = { workDirty, unpushedCommits }` (from `we:scripts/lib/lane-history.mjs#laneStateSnapshot`, line 354) and a new hold `unpreserved-work`. For `action: 'release'` with `byHolder !== true`, the verdict is: hold when `workDirty > 0` or `unpushedCommits > 0`; hold `work-state-unknown` when either is null (failed read); allow only when both are 0. Two details matter. (1) Use `workDirty` (allowlisted scratch litter such as `.commit-msg.txt` excluded) and `unpushedCommits` (commits on no remote ref), never the existing `unpushed` boolean: that one counts raw `dirty`, so a lane with only litter would be held forever and the pool would fill with unreapable lanes. (2) `laneHoldNeedsWorkState` (line 620) currently returns false when there is no verify record, so `checkLaneHold` never reads the work state; it must return true for a non-holder release so the facts are read. (3) The `release` call site (we:scripts/lane-pool.mjs line 2721) passes `unpushed: beforeLitter.unpushed`, a boolean, and `checkLaneHold` skips its own state read whenever `unpushed` is a boolean; the build must pass the already-read `workDirty` and `unpushedCommits` through `laneHoldRefuses` (line 1801) as a `work` option so that path does not see an undefined `work`. (4) "Unpushed" must not over-hold: `unpushedCommits` means "on no remote ref", and a lane whose commits were pushed by URL, or squash-merged with a pruned branch, shows on no ref (`we:scripts/lib/lane-hold-io.mjs` lines 124-137 documents the push-by-URL case). Before holding on `unpushedCommits > 0` with `workDirty === 0`, reuse the same two proofs the verified-unpushed path and acquire already use: `liveRemoteHasRevision` for the head sha, and `aheadIsProvablyPushed` (we:scripts/lane-pool.mjs line 970, patch-equivalence) for the squash-merge case; uncommitted work is never excused this way. Known cost: a held lane keeps its lease marker, and the health-watch salvage planner (we:scripts/conveyor/lane-pool-health-watch.mjs `planSalvageCandidates`) requires no lease, so a held lane stays held until its work is preserved by hand (`reclaim --salvage`) or a later ruling; the resume report is what makes it visible. The holder's own release stays allowed (line 650). Scope the new hold to `release` only for the MVP: `reset`/`take-over` on acquire already refuse dirty or ahead lanes through `isLaneAcquirable`'s `dirtyOrAhead` guard (#2267), and `reclaim --salvage` (`we:scripts/lane-pool.mjs#cmdReclaimSalvage`, line 4180) snapshots the work before dropping the lease, so it must stay allowed; the build verifies that path still passes. The reaper already routes a refusal to `keep` with reason `held:<hold>` and logs it, so no reaper change beyond a test is expected. Fail-closed direction only: an empty lane (both zero) is reaped exactly as today.

**B. Launch record plus resume report (ask 2, ruling c).**
- we:scripts/operations/worker-launch-record.mjs: a hook pair (matcher `Agent|Task`) registered in we:.claude/settings.json: `PreToolUse` writes the record at launch (so a foreground launch that an account switch kills mid-flight is still recorded; the ruling says "at launch") and `PostToolUse` best-effort adds `agentId` from the tool response. Same module, `--phase=pre|post`, in the style of we:scripts/guard-monitor-subagent.mjs (hook JSON on stdin, pure build function, fail open, exit 0 always). It writes one JSON file per launch under `~/workspace/.operations/worker-launches/<parent-session-id>/` (outside the repo and outside `~/.claude`, the same reasoning as `we:scripts/operations/handoff-home.mjs#handoffHome`): `schemaVersion`, `launchedAt`, `parentSessionId`, `agentId` (from the tool response when present), `description`, `subagentType`, `background`, `lane` (only when the brief text names `--lane=N`; otherwise null, because the worker acquires its lane after launch), `cwd`. The file name is derived from `parentSessionId` plus the tool-use id and written with `writeJsonAtomic` (we:scripts/lib/atomic-json-file.mjs), so a repeated hook fire is idempotent.
- we:scripts/operations/resume-report.mjs: one command with `--session=<id>` and `--json` options. Pure core `classifyLaneContentState({ workDirty, unpushedCommits, ahead })` returns `unknown` (any null) > `uncommitted` > `committed-unpushed` > `pushed` (ahead of main but every commit on a remote) > `clean`. IO shell: (1) read launch records for the session (default: the newest parent session with records); (2) join each to lane leases: by `lane` when the record names one; otherwise by lease `workerSession`/`session` equal to the record's `agentId` when known; otherwise by `ownerSession` equal to the record's `parentSessionId` with `acquiredAt >= launchedAt`. In-process workers share the parent's session id (see the comment at we:scripts/lane-pool.mjs line 2700), so the last form can match several records to several leases: when it is not one-to-one, the row reports `lane ambiguous` with the candidate lanes and never picks one (the lease rows still appear as `unrecorded` candidates, so no lane is dropped from the list). Identity keys follow we:scripts/lib/lane-salvage.mjs#leaseSessionIds and the join in we:scripts/operations/agent-activity.mjs resolver 4. Walking pools with `we:scripts/lib/lane-pool-scan.mjs#poolsWithLanes` and `laneIndicesIn`; (3) liveness from `claude agents --json --all` for background rows and `we:scripts/lib/lane-salvage.mjs#liveAgentInLane` for lane-bound ones, else `unknown` (an in-process worker is not listed anywhere; the report says so rather than guessing); (4) **fallback**: every held lane lease with no matching launch record is listed as `unrecorded` with the same lane state. Output is a table: worker, source (`launch-record` or `reconstructed`), alive, lane, content-state.
- we:.claude/commands/continue.md gets one added instruction: run the report after the existing reaper step and list any `uncommitted` or `committed-unpushed` row before resuming work.

**C. Which account (ask 3).** Chosen mechanism: **stamp at acquire, compare on demand** (not an interval poll: a poll needs a daemon and only says "changed", while a stamp says who did the work and who is acting now). we:scripts/lib/account-identity.mjs reads the two identities cheaply and read-only: the Claude CLI login from `claude auth status --json` (the same ~0.15 s probe `we:scripts/conveyor/claude-auth-health.mjs#probeClaudeLoggedIn`, line 157, uses; fields `email`, `orgId`, `authMethod`, `loggedIn`) and the GitHub login from `gh auth status`. It returns `{ claude: { fp, label }, github: { login } }` where `fp` is a short SHA-256 of `orgId + email` and `label` a masked email (never the raw address, never a token), or `unknown` per surface on any failure. `we:scripts/lane-pool.mjs#cmdAcquire` (line 1968) stamps that into the lease through `we:scripts/lib/lane-lease.mjs#leaseBody` (line 178, new optional `account` field, best-effort: a failed read stamps `unknown`, never blocks acquire). The resume report gains an account block: current identity, plus a per-lane column `acct` = `same` / `switched` / `unknown` against each lease's stamp. we:docs/agent/dispatcher-runbook.md gets a short section: which daemon authenticates as what (CLI-login daemons act as the Claude login; GitHub App daemons act as the App via we:scripts/lib/github-app-auth-env.mjs, inspect with we:scripts/conveyor/github-app-status.mjs) and how to check.

## MVP

Musts only:
1. The `unpreserved-work` hold on non-holder `release`, with the `laneHoldNeedsWorkState` change and the fail-closed unknown case (slice A).
2. The launch-record hook and the resume report with the `unrecorded` fallback, wired into `/continue` (slice B).
3. The account identity read, the lease `account` stamp, the `acct` column and the runbook section (slice C).

Deliberately OUT (see Follow-ups): auto-salvage of a held lane, a health smell for long-held lanes, restarting stopped workers, the iOS Code tab latency (evidence item (d)), any daemon behaviour change on `switched`.

## Edge cases this change must handle

1. **Untrusted text** — the launch record stores the worker's description and brief text, both agent-authored: fold newlines and backticks when the report prints them (`foldUntrusted`, we:scripts/lib/jury-core.mjs); the `--lane=N` parse accepts digits only; a session id or tool-use id used in a file name is validated against `^[A-Za-z0-9._-]+$` before use; the masked account label never contains the raw address. Case in Test plan.
2. **Truncated reads** — `claude agents --json --all` and git reads go through a bounded `maxBuffer` (we:scripts/lib/proc-read.mjs); a failed or truncated listing makes liveness `unknown`, never "dead"; `laneStateSnapshot` already returns null per field on a failed read and the verdict treats null as `work-state-unknown`.
3. **Shared state files** — launch records are one file per launch (no shared file to race), written atomically; a repeated hook fire overwrites the same name. The lease `account` field is written inside the existing atomic lease write at acquire.
4. **Fail closed** — an unreadable lane state holds the release (`work-state-unknown`); an unreadable account is `unknown`, never `same`; an unparseable launch record is listed as `unreadable`, never skipped. The hook itself fails OPEN (exit 0) because it is bookkeeping and must never wedge a tool call; the report then falls back to reconstruction, which is why ruling (c) wants both.
5. **Identity scoping** — launch records are keyed by parent session id plus tool-use id; lease joins match on the full session slug, never a prefix; no card number or hash is used as a key, so the two spellings do not arise.
6. **State over time** — a launch record outlives its lane: the report shows `lane released` rather than inventing a state; records older than 14 days are ignored by the default listing (not deleted); a held lane stays held until something preserves its work (the resume report is the surface that makes that visible); a lease re-acquired by a new session after a release must not match the old launch record (the join also requires `acquiredAt >= launchedAt`).
7. **Who wrote it** — a launch record is trusted only from the hook's own directory under the operator's home; the account stamp is written only by `acquire` itself, and the report never treats a stamp found in a lane's own `.git` as proof of identity beyond "what acquire recorded".

## Test plan

Slice A, in we:scripts/lib/__tests__/lane-lease.test.mjs, we:scripts/lib/__tests__/lane-hold-io.test.mjs and we:scripts/conveyor/__tests__/lease-reaper.test.mjs:
- `laneHoldVerdict` release, not holder, no verify record, `work.unpushedCommits = 1` → `allowed:false`, `hold:'unpreserved-work'`. RED today: returns `allow('no hold signal')`.
- same with `work.workDirty = 6` (the lane-8 shape) → held. RED today for the same reason.
- same with `workDirty = 0, unpushedCommits = 0` → allowed (an empty lane is still reaped; the Risk 1 guard).
- `work.workDirty = null` → `work-state-unknown` (fail closed). RED today: allowed.
- `byHolder: true` release → allowed whatever the work state (the holder releases its own lane).
- a litter-only lane (only `.commit-msg.txt` dirty) → allowed (`workDirty` excludes litter). Guards against filling the pool with unreapable lanes.
- `laneHoldNeedsWorkState` is true for a non-holder release with no verify record. RED today: false, so the work state is never read.
- `checkLaneHold` on a real temp git repo (one unpushed commit, no verify record) → held with facts populated. RED today: allowed.
- `checkLaneHold` called the way `release` calls it (a pre-supplied boolean `unpushed: true` and a `work` option) still holds, and with a boolean but no `work` it reads the state itself rather than treating `work` as absent. RED today: allowed.
- stale-ref guard: a lane with zero `workDirty` whose head is on the live remote (`remoteHas` true) or whose commits are patch-equivalent to origin (squash-merged, branch pruned) → allowed; the same lane with one uncommitted tracked file → held (uncommitted work is never excused). The first half passes today (a guard); the second is RED today.
- `applyLaneHold` over a candidate the reaper classified reapable (session gone) with the real check on that temp repo → moved to `keep` with reason `held:unpreserved-work`; `wouldHaveBeen` carries the original reason. RED today: it stays in `reap`.
- the `release --force` command of we:scripts/lane-pool.mjs, run by a non-holder on a lane with an uncommitted tracked file, refuses and leaves the marker. RED today: marker dropped.
- `reclaim --salvage` on the same lane still succeeds (it preserves first). Guards that slice A does not trap the explicit rescue path.

Slice B, in we:scripts/operations/__tests__/worker-launch-record.test.mjs and we:scripts/operations/__tests__/resume-report.test.mjs:
- hook build function: a captured live `PostToolUse` Agent payload fixture (captured during the build, see Proof plan) → one record with the expected fields; malformed or empty stdin → no record, exit 0, no throw. RED before the module exists.
- unsafe session id (`../x`, leading `--`) → refused, nothing written outside the records directory.
- repeated fire of the same event → one file, same content.
- `classifyLaneContentState` table: every combination of null/0/positive for `workDirty`, `unpushedCommits`, `ahead` → the documented state; null always `unknown`.
- pre phase writes a record with no `agentId`; the post phase for the same tool-use id fills it in and leaves other fields unchanged (one file). A foreground launch with only a pre event still yields a record.
- ambiguous join: two records and two leases sharing one `ownerSession`, no lane named → both rows read `lane ambiguous` listing both lanes; neither is silently paired.
- report join: a record with a matching lease → `launch-record` row with the lane state; a lease with no record → `unrecorded` row (the fallback); a record whose lane was released → `lane released`; a lease re-acquired after the launch time does not match the old record.
- liveness: a failed `claude agents` read → `unknown`, never `dead`.
- hostile description text (newline, backticks, `--flag`) → folded in table and JSON output.

Slice C, in we:scripts/lib/__tests__/account-identity.test.mjs:
- parse of a `claude auth status --json` fixture → stable `fp`, masked `label`, no raw email anywhere in the returned object (assert by serialising it and searching for the address).
- `loggedIn:false`, exec throw, unparseable output → `unknown`.
- comparison: same fp → `same`; different → `switched`; either side unknown → `unknown` (never `same`).
- `leaseBody` with and without an `account` field is backward compatible (older leases lack it → `unknown`).

## Proof plan

Run live from the build lane; no fixtures stand in for these.
1. **Slice A before/after on the real reaper.** Build a throwaway pool under a temp `LANE_POOL_ROOT` (the reaper reads it, we:scripts/conveyor/lease-reaper.mjs line 1185): a clone with one unpushed commit, and a lease naming a dispatcher-style session that `claude agents` does not list, acquired beyond the grace window. Run the reaper with `--dry-run --json` on `origin/main` (BEFORE: lists it under `wouldReap`) and on the branch (AFTER: counted in `kept`, log line `kept ... held:unpreserved-work`). Repeat with an empty lane to show it is still reaped. Paste both outputs in the PR.
2. **Slice B on a real hook.** Run a one-shot `claude -p` in the lane with the repo's hook settings that launches one trivial subagent; show the record file the hook wrote and keep its stdin payload as the test fixture. Then run the resume report against the real pool (read-only) and paste the table, showing at least one `launch-record` row and any `unrecorded` rows.
3. **Slice C.** Run the identity read live and paste the masked output; then point `CLAUDE_CONFIG_DIR` at an empty directory to show it reads `unknown` (not `same`); show a fixture-stamped lease reading `switched`.
4. **Incident replay (tier-3 acceptance).** In the throwaway pool, stop a worker mid-work (lease held, uncommitted files, unpushed commit), run the reaper, then run the resume report: the lane is still there and the report lists it as `uncommitted` or `committed-unpushed`.

## Follow-ups

- Bounded escalation for a lane held a long time by `unpreserved-work` (auto-salvage via `we:scripts/lib/lane-salvage.mjs#salvageLane`, or a health smell): needs an operator ruling on how long "never reclaim" may last.
- Reaper summary line counting `held:unpreserved-work` lanes so the operator sees pool pressure.
- Extend the `unpreserved-work` hold to `reset`/`take-over` once the acquire-side guards are shown redundant.
- A resume-side action to re-attach a stopped worker's lane to a new session.
- iOS Code tab slow to surface a resumed session (evidence item (d)): a client-side matter, no repo mechanism identified.
- Reacting to `switched` (pausing daemons on an account change) beyond reporting it.

## Done when

1. **Executable** — `npx vitest run` over the six test files named in `## Test plan` (we:scripts/lib/__tests__/lane-lease.test.mjs, we:scripts/lib/__tests__/lane-hold-io.test.mjs, we:scripts/conveyor/__tests__/lease-reaper.test.mjs, we:scripts/lib/__tests__/account-identity.test.mjs, we:scripts/operations/__tests__/worker-launch-record.test.mjs, we:scripts/operations/__tests__/resume-report.test.mjs) is green.
   Tier-3 acceptance: after a mid-session account switch, a resumed session can, via one documented
   command, list every stopped background worker and its lane's content-state, and a worker's own
   unpushed/uncommitted work is never silently dropped the way this incident's items (b) and (c) were.
