#!/usr/bin/env node
/**
 * @file scripts/conveyor/lease-reaper.mjs
 * @description The CONVEYOR LEASE REAPER (WE #2667, epic #2612). Walks every lane pool and RECLAIMS an orphan
 *   lease — one whose owning agent is gone — so a stranded lane returns to the pool automatically instead of
 *   being hand-released by the main session. This is the RECLAMATION half that #2623 was missing.
 *
 * WHY (the toil this removes): when a conveyor delivery agent dies mid-build (an API death), or its PR merges
 * without the main session hand-releasing the lease, the `.lane-lease` marker sits on disk holding its lane —
 * in EVERY pool the item acquired (a cross-locus couple leaves one in the WE pool AND one in the plateau-app
 * pool). #2623 taught the scope-lease COLLECTOR to COUNT such empty/stale leases correctly (so the dispatch
 * plan's free-lane math is right), but it never REMOVED them — a counted-as-stale lease still occupies its lane
 * until a human clears it. This reaper is the reclamation: it removes the marker, freeing the lane for dispatch.
 * Observed real ghosts: 13 lanes across 3 pools released by hand — exactly what this automates.
 *
 * EXTENDS #2623 (counting → reclaiming), and is the periodic BACKSTOP to the merge-time auto-release
 * (`pr-watch.mjs --release-session`, #2667): auto-release clears a couple's leases the instant its PR merges;
 * the reaper catches everything auto-release missed — a dead agent that never opened a PR (rides the TTL-stale
 * axis), or a merge whose main session was down when it landed (rides the PR-merged axis).
 *
 * PURE-CORE / IO-SHELL SPLIT (mirrors pr-watch.mjs / scope-lease-collect.mjs):
 *   • The PURE core ({@link classifyReap}, {@link reapPlan}, {@link itemNumFromSession}, {@link laneRefItemNum},
 *     {@link sessionStateByName}, {@link sessionStatesForReap}, {@link sessionGoneForLease}) has NO fs / git /
 *     gh / clock — every signal is passed IN (the one exception, `sessionGoneForLease`'s own `nowMs`, is a
 *     clock READING handed in by the caller, never read from the wall clock itself). It is unit-tested directly
 *     against fixtures.
 *   • The IO SHELL (the `main()` CLI, gated on the main-module check) owns POOL_ROOT enumeration, marker reads,
 *     an optional single `gh pr list`, an optional single `claude agents --json --all`, and the actual
 *     reclamation — which it delegates to `lane-pool.mjs release --pool=<name> --lane=<n> --force` so the
 *     reserved-lane protection lives in ONE place (this reaper never rm's a marker directly, so it can never
 *     nuke a permanent memory lane).
 *
 * THE REAP AXES (a lease is reaped when it is NOT reserved AND any one holds):
 *   • pr-merged / pr-closed — the lease's item PR reached a terminal state (matched by head ref `lane/<num>-*`);
 *     the work is done/abandoned, so the lane is free even before TTL. Because a cross-locus couple's WE PR is
 *     WE-last, a merged WE PR (num N) means the whole couple is done — so matching by `num` reclaims the
 *     plateau-app-pool half too. (Best-effort: the gh axis degrades to OFF if gh is unavailable — TTL still bites.)
 *   • session-gone — the lease's OWNING DELIVERY-AGENT SESSION is confirmed gone (WE #3466/#2412, found live
 *     2026-09-04/05 — see {@link sessionGoneForLease}). A conveyor-dispatched build's session can die/disappear
 *     entirely from `claude agents --json` (the underlying OS process itself confirmed dead via `ps -p <pid>`)
 *     while the LANE LEASE it minted stays held: nothing on the TTL/PR axes reclaims it until the FULL 4-hour
 *     `ttlMinutes` elapses, blocking real dispatch capacity the whole time (a live incident: ~12 items stuck on
 *     "no free lane" for hours behind two leases whose sessions had already died). This axis closes that gap by
 *     asking `claude agents --json --all` — the SAME listing `session-reaper.mjs` already reads — whether the
 *     lease's own `session` name is still there; a name absent entirely AND past the {@link
 *     DISPATCH_GUARD_LISTING_GRACE_MINUTES} listing-visibility grace window, or present but in one of the
 *     states `session-reaper.mjs` itself already treats as done (`done`/`failed`/`stopped`), reclaims the lane
 *     even pre-TTL. Best-effort: the axis degrades to OFF if the listing is unavailable OR came back with zero
 *     background rows (indistinguishable from a bad read — see {@link sessionStatesForReap}) — TTL still bites.
 *     Independent review of PR #1921 caught two real gaps in the first cut, both closed here (not merely
 *     acknowledged): an all-empty listing would have read as "everyone's gone" fleet-wide, and a lease acquired
 *     moments ago (whose session had not yet had time to appear in the listing) would have been reaped mid-start
 *     — the exact #3283 "reclaims a lane seconds after it is acquired" failure, reintroduced through this axis.
 *     #3383 (2026-09-14) WIDENED this axis again: `claude agents --json --all` can also report a PHANTOM row —
 *     LISTED, in a non-terminal state (`working`/`blocked`), with NO backing OS process at all (the same "still
 *     listed, nothing behind it" decay `driver-watchdog.mjs` found live for the driver's own queue-claim check,
 *     `splitQueue`, the same day). Neither the absence branch nor the terminal-state check above catches that
 *     shape — the row IS present and its `state` never transitions on its own. `sessionGoneForLease` now also
 *     takes a REAL, direct `pidAlive` read for the lease's session (`sessionPidAliveByName`, reusing
 *     `driver-watchdog.mjs`'s own `resolvePidAlive`/`scanPsOutput` two-signal probe — a listing row's own `pid`
 *     when present, else a `ps aux` scan for its full `sessionId`), and `pidAlive === false` reaps regardless of
 *     the listed state or lease age. Confirmed live: 12 of 14 "leased" lanes had no corroborating process
 *     anywhere on the box, several sessions silent 4+ hours, none of them near their 240-minute TTL.
 *   • ttl-stale — the lease outlived its TTL (`isLeaseStale`; AGE-based — there is no heartbeat, so a >TTL live
 *     build is reapable, exactly as `acquire` already treats a >TTL lease as reclaimable); the owner is presumed
 *     gone. This is the zero-IO backstop that reclaims a dead agent's lane with no PR, no network, and no
 *     session-gone signal (e.g. the listing was unavailable, or the session name matches no dispatcher grammar).
 *   • pid-dead — the owning agent's process is gone. DORMANT under today's schema (see {@link pidAliveForLease}):
 *     the lease's recorded `pid` is the short-lived `lane-pool acquire` CLI, NOT the delivery agent (an LLM has
 *     no unix pid), so a literal check would reap LIVE leases — the axis returns `null` (unknown) and never
 *     fires alone. The pure branch is kept so a future durable `agentPid` field lights it up unchanged. THIS IS
 *     WHY session-gone (above), not a literal `lease.pid` liveness check, is the real fix for the 2026-09-04/05
 *     incident: `lease.pid` is documented (`lane-lease.mjs`'s `leaseBody`) to be the short-lived acquire CLI on
 *     EVERY lease, live ones included — checking it would reap a live build's lane on sight, not just a dead
 *     one. The lease carries no durable, checkable agent pid at all; the delivery agent's OWN session identity
 *     (its `session` name, matched against the real `claude agents` registry) is the trustworthy liveness signal
 *     that actually exists today.
 * RESERVED (permanent memory, #2350) leases are NEVER reaped, on every axis.
 */

import { parseSessionSlug } from './session-slug.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { isLeaseStale, isReservedLease, LEASE_FILENAME, DEFAULT_LEASE_TTL_MINUTES } from '../lib/lane-lease.mjs';
import { defaultListAgents } from '../operations/dispatch-lane-io.mjs';
// #xbk2is9 — REUSE, never reimplement, the reclaim `--salvage` gate's own "is this lease's owning agent live"
// check (`liveAgentInLane`, `lib/lane-salvage.mjs`) — see {@link ownerSessionAliveForLease}'s own docblock.
import { liveAgentInLane } from '../lib/lane-salvage.mjs';
// #3903 — a mechanical dispatch's detached wrapper holds its lease; its `pid:<n>` handle lives in the run store.
import { detachedHandlePid } from '../operations/detached-dispatch.mjs';
import { createFileRunStore } from '../operations/run-store.mjs';
import { DISPATCH_GUARD_LISTING_GRACE_MINUTES } from '../operations/dispatch-lane.mjs';
// #4415 — live incident 2026-09-29: this file's own `gh pr list --state all` (below) was a bare `execFileSync`,
// invisible to `gh-throttle.mjs`'s attribution log AND paid out of the small GraphQL bucket — one call per
// constellation repo with a held lease, EVERY tick of the resident `lease-reaper` launchd daemon (ThrottleInterval
// 60s, but re-armed instantly under `KeepAlive`, so effectively every pass-daemon interval). Measured live: this
// was the single largest UNATTRIBUTED slice of the app's GraphQL spend (`gh-spend.mjs report`'s own bucket total
// minus every row it could explain). Converted to the SAME REST + ETag-conditional path #4351 already built for
// `build-dispatch-daemon.mjs`'s own top-spender fix (`../lib/gh-rest-read.mjs#ghRestGetPaged`, via the shared
// throttle) — spends the separate `core` bucket instead of `graphql`, is attributed by caller+op, and an
// unchanged page (the common case between reaps) costs nothing at all (a cached 304).
import { ghRestGetPaged } from '../lib/gh-rest-read.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
// #xr4ygg7 (multi-repo slice 9, we:reports/2026-09-23-conveyor-multi-repo-gap-map.md) — the constellation table,
// so a lease's POOL (ground truth) and a `fix-<tag>-<id>` session's own tag both resolve through the ONE source
// every other conveyor script already keys off, never a private re-derivation here.
import { CONSTELLATION_REPOS, repoKeyForDir } from '../lib/constellation-repos.mjs';
import { isCherryOutputAllPatchEquivalent } from '../lib/git-patch-equivalence.mjs';
import { LANE_JOURNAL_ACTOR_ENV } from '../lib/lane-history.mjs';
import { timestampLines } from '../lib/log-timestamp.mjs';
// #3383 (this incident, 2026-09-14) — REUSE, never reimplement, the real PID-liveness probe `driver-watchdog.mjs`
// just built for the IDENTICAL gap in a different place: a `claude agents --json` row can be a PHANTOM — still
// LISTED (present, in some non-terminal state like `working`/`blocked`), with NO backing OS process at all (that
// file's own header: sessions whose transcripts had gone silent for hours/days while the listing kept reporting
// them as if alive). `sessionGoneForLease` below only ever checked ABSENCE-past-grace or a listed TERMINAL state
// (`done`/`failed`/`stopped`) — neither catches a phantom that is listed in a NON-terminal state, which is
// exactly the shape of tonight's incident: 12 lane leases held for 4+ hours by sessions still "in the listing"
// but with zero corroborating process anywhere on the box. `resolvePidAlive`/`scanPsOutput`/`defaultIsPidAlive`
// are the SAME two-signal probe `we:scripts/operations/clear-stuck-session-io.mjs#resolvePidAlive`/
// `scanPsForSession` established first (a listing row's own `pid` when present, else a `ps aux` scan for its
// full `sessionId`) — reused verbatim, not re-derived a third time. No import cycle: `driver-watchdog.test.mjs`'s
// own asserted import graph never reaches this file or `lane-pool.mjs`.
import { resolvePidAlive, scanPsOutput, defaultIsPidAlive } from './driver-watchdog.mjs';

// ── PURE CORE (no fs / git / gh / clock — every signal is injected) ───────────────────────────────────────────

/**
 * The item number a lane's owning session encodes, or null when the session names no item.
 *
 * THE KEY IS A GRAMMAR, NOT "THE TRAILING DIGIT RUN OF ANYTHING" (#3283). This matched `(\d+)[a-z]?$` against
 * any slug, so EVERY digit-tailed session aliased onto whatever backlog card those digits happened to name:
 * `probe1` read as item 1; `rv1566j` (a review juror for **PR** 1566) read as item 1566; `Mac:24827` — the
 * `hostname():ppid` shape `defaultSession()` mints for an acquire with no `--session`
 * (`we:scripts/lane-pool.mjs:526`) — read as item 24827; a minted `holder` slug's hex tail read as an item too.
 * Roughly four in five live backlog ids name a `status: resolved` card, so an aliased lease was far more
 * likely than not to look instantly reapable to the acquire-native reaper — which is how a lane handed out
 * seconds earlier got reclaimed by the very next acquire, collapsing a whole pool onto one lane.
 *
 * The accepted shapes are exactly the ones the dispatcher MINTS — `sessionSlugFor`
 * (`we:scripts/operations/dispatch-lane.mjs:202`) and `releaseSessionForNum`
 * (`we:scripts/conveyor/tick-core.mjs:582`) both emit `conveyor-<id>` / `prepare-<id>` /
 * `prepare-decision-<id>`, and `fix-<id>` is the historical fourth — plus the retry suffix (`conveyor-2500b`),
 * which still collapses to the base number so a live retry and its base share one key (the #2267 "open wins"
 * safety in {@link prStatesFromList} depends on that collapse).
 *
 * A HASH-identified item (`conveyor-x9ylkp7`) deliberately yields null rather than its own key: a lease
 * session is only ever LOOKED UP here, and the only Map it is looked up in is keyed by {@link laneRefItemNum},
 * whose hash keys were minted for the dispatch observer, not the reap path. Returning null keeps that key
 * unreachable — the same conclusion the widening docblock below records, now for the stronger reason that
 * there is no key at all instead of a WRONG one (`conveyor-x9ylkp7` used to read as item `7`).
 *
 * @param {string|null|undefined} session
 * @returns {string|null}
 */
/** Shared match, so {@link itemNumFromSession} and {@link sessionSlugAttemptTag} can never disagree about
 *  where the retry-suffix letter sits — same reason {@link laneRefItemNum} names for its own couple.
 *
 *  #xr4ygg7 (multi-repo slice 9) — WIDENED to match a `fix-<tag>-<id>` session for ANY constellation repo, not
 *  only `we`. Before this, a dead `fix-pa-181`/`fix-fui-49` session's lane was reclaimed ONLY by the zero-IO
 *  TTL-stale backstop (4 hours) — the PR-terminal and session-gone axes were both structurally unreachable for
 *  it, because `itemNumFromSession` (the only lookup key either axis has) returned `null` for any non-`we`
 *  tagged session. That is the exact gap `we:backlog/xr4ygg7-*.md` names: "dead leases in the frontierui and
 *  plateau pools are reclaimed only by TTL". Item-kind sessions (`conveyor-`/`prepare-`/`prepare-decision-`)
 *  are UNAFFECTED — `mintSessionSlug` forbids them from ever carrying a non-`we` repo tag, so `parsed.repo` is
 *  always `'we'` for those and this widening only ever activates a NEW path for `fix-<tag>-<id>`.
 *
 *  WHY THIS IS SAFE despite widening what `itemNumFromSession` returns: the PR-terminal axis is the one that
 *  could turn "yes, this session names an item" into a WRONG reap if the lookup then mixed repos — e.g. reading
 *  a merged WE PR #49 as proof that plateau-app's OWN, unrelated item 49 is done. That hazard is closed at the
 *  LOOKUP, not here: the IO shell's `fetchPrStatesForRepo`/`prStatesByRepo` key every PR-state Map by repo (see
 *  their own docblocks), so a plateau-app lease's num is only ever checked against plateau-app's own `gh pr
 *  list`, never WE's. `lane-pool.mjs`'s acquire-native backstop (the OTHER consumer of this widened
 *  `itemNumFromSession`) was ALREADY per-repo-scoped before this change (its own `gh pr list` runs with
 *  `cwd: repo.referencePath`, i.e. inside the ONE pool being acquired against) — so it needed no change at all
 *  to safely benefit from the wider match.
 *
 *  #x5wm9ot — WIDENED AGAIN, and the return shape SPLIT. Two separate bugs shared this one function:
 *
 *  (1) It matched `parsed.itemKind || parsed.kind === 'fix'` — every OTHER `PR_KIND` (`review`, `ci-heal`,
 *      `inspect`; see `session-slug.mjs`) fell through to `null`. Those sessions are just as PR-keyed as `fix`
 *      — `review-<PR>`, `ci-heal-<PR>`, `inspect-<PR>` all encode a PR number the exact same way `fix-<PR>`
 *      does — so a dead review/ci-heal/inspect lane was invisible to BOTH consumers of this match (the
 *      PR-terminal axis below, and `sessionGoneForLease`'s "is this a dispatcher-minted name at all" gate),
 *      reclaimed only by the 4h TTL backstop. Now every `PR_KIND` matches, not `fix` alone.
 *
 *  (2) `itemNumFromSession` handed BOTH namespaces out through one name and one field. `fix-<PR>`'s `id` IS a
 *      PR's own number (`mintSessionSlug({kind:'fix', id: pr})` at every call site — `review-status-tag.mjs`,
 *      `parked-pr-progress-watch.mjs` — always mints it FROM a PR number), but every caller that fed
 *      `itemNumFromSession`'s result into `prStatesFromList`'s Map (below, in this file, AND in
 *      `lane-pool.mjs`'s `deadLeasePlan`) was looking a PR number up in a Map keyed by the ITEM number embedded
 *      in a PR's OWN head ref (`lane/<num>-*`) — a different namespace, coincidentally equal only by chance.
 *      `lane-pool.mjs`'s `cmdReleaseAllPools --item=N` inherited the identical mixup: a `fix-<PR>` lease could
 *      match a land-time `--item=N` sweep whenever that PR's number happened to equal the just-landed item's.
 *      `itemNumFromSession` now returns a num ONLY for a TRUE item-kind session (`conveyor-`/`prepare-`/
 *      `prepare-decision-`) — never for any `PR_KIND` — and the new {@link prNumFromSession} is the ONLY way
 *      to read a PR_KIND session's own PR number back out. A caller needing "is this session's target PR
 *      merged/closed" must go through `prNumFromSession` + a PR-number-keyed Map (see `prStatesByPrNumber`
 *      below), never through `itemNumFromSession` + the head-ref-keyed one. */
function matchSessionSlug(session) {
  const parsed = parseSessionSlug(session);
  return parsed ? { num: parsed.id, tag: parsed.attempt, repo: parsed.repo, itemKind: parsed.itemKind } : null;
}

/** A TRUE backlog-item number (`conveyor-`/`prepare-`/`prepare-decision-<id>`) — never a PR_KIND session's own
 *  PR number (see {@link prNumFromSession} for that, a DIFFERENT namespace this function must never mix in). */
export function itemNumFromSession(session) {
  const m = matchSessionSlug(session);
  return m && m.itemKind ? m.num : null;
}

/** The PR number a PR_KIND session's slug names (`review-`/`fix-`/`ci-heal-`/`inspect-<PR>`) — never a backlog
 *  item number (see {@link itemNumFromSession}). `null` for an item-kind session or an unrecognized name. */
export function prNumFromSession(session) {
  const m = matchSessionSlug(session);
  return m && !m.itemKind ? m.num : null;
}

/** Is `session` ANY dispatcher-minted slug this grammar recognizes — item-kind or PR-kind alike? The general
 *  "recognized name" gate `sessionGoneForLease` needs (never `itemNumFromSession`, which is now item-kind-only
 *  and would wrongly read every PR_KIND session as "not dispatcher-minted, don't guess" — see #x5wm9ot). */
function isDispatcherMintedSession(session) {
  return matchSessionSlug(session) !== null;
}

/**
 * #xr4ygg7 (multi-repo slice 9) — the internal repo key a lane-pool DIRECTORY NAME names (`'web-everything'` /
 * `'webeverything'` → `'we'`, `'frontierui'` → `'frontierui'`, `'plateau-app'` → `'plateau-app'`), or `null` for
 * a pool this constellation table doesn't recognize (a one-off scratch clone under `POOL_ROOT` that never has
 * `lane-N` children, so `poolsToScan` never surfaces it here anyway — this only ever sees a real per-repo lane
 * pool's own dir name). THE GROUND TRUTH for which repo a held lease belongs to, used instead of the lease's
 * own `session` field: the pool a lane is checked out under cannot be wrong the way a free-text session name
 * conceivably could be. A thin, named wrapper over `constellation-repos.mjs#repoKeyForDir` — reused, not
 * re-derived — so a reader searching this file for "which repo is this pool" finds the answer here.
 * @param {string} poolName
 * @returns {string|null}
 */
export function repoKeyForPool(poolName) {
  return repoKeyForDir(poolName);
}

/**
 * #3110 — the retry-suffix letter a `conveyor-<id>[a-z]` session slug carries (`''` for an unsuffixed first
 * attempt, `'b'`/`'c'`/… for a second/third/… retry — the exact shape this file's own docblock above already
 * named, `conveyor-2500b`), or `null` when `session` doesn't match the slug grammar at all. `null` and `''`
 * are deliberately distinct: `null` means "not a conveyor session slug, say nothing", `''` means "a genuine
 * first attempt", and the two must never be conflated by a caller comparing tags for equality.
 * @param {string|null|undefined} session
 * @returns {string|null}
 */
export function sessionSlugAttemptTag(session) {
  return matchSessionSlug(session)?.tag ?? null;
}

/**
 * The item id a `lane/<num>-<slug>` head ref encodes (mirrors `itemNumFromSession`'s couple key), or null.
 * A conveyor PR is opened by `pr-land --ref=lane/<num>-<slug>`, so its head ref carries the item id.
 *
 * THE GRAMMAR IS `pr-land`'S, NOT A SECOND ONE (#x9ylkp7, task 4). `we:scripts/pr-land.mjs` parses its own
 * `--ref` with `^lane\/(x[a-z0-9]{5,7}|\d+)` — a backlog item is identified EITHER by its number OR by its
 * `bornAs` hash (`x9ylkp7`), and the delivery-agent brief's `{{ITEM_NUM}}` is documented to be "the backlog
 * item number (or `xNNNNNN` hash)". This matcher accepted only the digit half, so every hash-identified item's
 * PR read as "no item at all". Widening it HERE rather than in a second copy is the whole point: the lease
 * reaper and the dispatch observer (`we:scripts/operations/dispatch-lane-io.mjs`) both key PRs to items through
 * this one function, so they can never disagree about which ref belongs to which item.
 *
 * WHAT THE WIDENING DOES **NOT** CHANGE, checked rather than assumed: {@link prStatesFromList} now mints
 * hash-keyed entries too, but {@link itemNumFromSession} — the only thing that ever LOOKS a key up in the
 * reaper — matches `(\d+)[a-z]?$` and so can only ever produce a digit key. A hash key is therefore
 * unreachable on the reap path, and the new keys collide with no existing one. The reaper's behaviour is
 * byte-identical; the observer is what the new keys are for. (`lease-reaper.test.mjs` pins exactly this.)
 *
 * A hash is lower-cased on the way out, matching `we:scripts/conveyor/queue-store.mjs`'s `normNum`; the digit
 * branch is unaffected by that (`'3095'.toLowerCase()` is `'3095'`).
 *
 * @param {string|null|undefined} headRef
 * @returns {string|null}
 */
/** Shared match, so {@link laneRefItemNum} and {@link laneRefAttemptTag} can never disagree about where the
 *  retry-suffix letter sits (same "one matcher, two readers never disagree" reasoning the docblock above gives
 *  for widening this grammar in one place rather than two). */
function matchLaneRef(headRef) {
  const m = String(headRef ?? '').match(/^lane\/(x[a-z0-9]{5,7}|\d+)([a-z]?)-/i);
  return m ? { num: m[1].toLowerCase(), tag: m[2].toLowerCase() } : null;
}

export function laneRefItemNum(headRef) {
  return matchLaneRef(headRef)?.num ?? null;
}

/**
 * #3110 — the retry-suffix letter a `lane/<num>[a-z]-<slug>` head ref carries (`''` for an unsuffixed first
 * attempt, `'b'`/`'c'`/… for a second/third/… retry), or `null` when `headRef` doesn't match the ref grammar
 * at all. Mirrors {@link sessionSlugAttemptTag}'s null/`''` distinction for the same reason: `null` means "not
 * a conveyor lane ref, say nothing", `''` means "a genuine first attempt".
 * @param {string|null|undefined} headRef
 * @returns {string|null}
 */
export function laneRefAttemptTag(headRef) {
  return matchLaneRef(headRef)?.tag ?? null;
}

// ── #xkk4lv7 — the branch-based item-resolution FALLBACK (capacity-cap root cause) ─────────────────────────────
// A lease acquired via a bare `lane-pool.mjs acquire --purpose=<slug>` with no dispatcher-recognizable
// `--session=` (`defaultSession()`'s `hostname():ppid` shape, or a one-off mechanical slug like `build-<num>`
// that doesn't match `session-slug.mjs`'s grammar — see this file's own header) resolves to `null` on BOTH
// `itemNumFromSession` and `prNumFromSession`, so it is invisible to the PR-terminal axis and to
// `sessionGoneForLease`'s recognized-name gate alike — reclaimable only by the 4-hour TTL backstop even once
// its PR has objectively merged (live evidence: lane-2/lane-9, #xkk4lv7's own root-cause writeup). The fallback
// below resolves the SAME `lane/<num>-*` grammar {@link matchLaneRef} already trusts for a PR's `headRefName`,
// this time off the lane's own checked-out branch — but ONLY once corroborated (see {@link laneQuietSincePr}),
// per the two blockers a light plan review found in the naive one-line design (this card's own Risks 8-9):
// Fork 1 — never invoked when EITHER `itemNumFromSession` OR `prNumFromSession` already resolves something
// (a correctly-resolved PR-kind lookup must never be silently overridden by an unrelated branch-derived item);
// Fork 2 — a bare branch name naming a merged/closed PR is NEVER, by itself, sufficient to reap (a lease can
// legitimately retain an OLD branch while doing genuinely NEW, live work in the same lane) — trusted only once
// corroborated by a clean/contained tree AND a conservative quiet window anchored to the LATER of the PR's own
// `mergedAt` and this lease's own `acquiredAt` (a fresh holder of an old-merged branch always gets its own full
// grace period, never an instant reap off a stale `mergedAt` alone).

/** Default {@link laneBranchItemNum} git reader: the lane's own checked-out branch name, or `null` on any
 *  failure (detached HEAD, mid-rebase, an unreadable/missing dir) — never throws, mirrors this file's other
 *  fail-closed git readers (`readLease`, `fetchPrStatesForRepo`). */
function defaultGitSymbolicRef(dir) {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: resolveChildTimeoutMs(),
      killSignal: 'SIGKILL',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The item id a lane's OWN checked-out branch encodes, via the SAME `lane/<num>-*`/`lane/x[a-z0-9]{5,7}-*`
 * grammar {@link matchLaneRef} already matches a PR's `headRefName` against — never a second, divergently-tuned
 * parser (this card's Risk 1). `null` on a detached HEAD, a branch outside the grammar (e.g. the lane's local
 * `main`, the byte-for-byte common case for a lane worked through the standard delivery-agent brief, where the
 * item lives only in the `--session=` slug, never the branch), or any git-read failure — never guess.
 * @param {string} dir - the lane's working-tree path.
 * @param {{git?:(dir:string)=>(string|null)}} [o] - `git` is injectable (a unit test never spawns real git).
 * @returns {string|null}
 */
export function laneBranchItemNum(dir, { git = defaultGitSymbolicRef } = {}) {
  let branch;
  try {
    branch = git(dir);
  } catch {
    return null;
  }
  if (typeof branch !== 'string' || !branch) return null;
  return matchLaneRef(branch)?.num ?? null;
}

/** Default {@link laneQuietSincePr} clean-tree reader: raw `git status --porcelain` output, or `null` on any
 *  failure (unreadable dir) — the caller then treats "can't confirm clean" as unknown, never as clean. */
function defaultGitStatusPorcelain(dir) {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: resolveChildTimeoutMs(),
      killSignal: 'SIGKILL',
    });
  } catch {
    return null;
  }
}

/**
 * Default {@link laneQuietSincePr} containment reader: is the lane's HEAD already fully reflected in `sha` —
 * either a literal ancestor-or-equal (`git merge-base --is-ancestor HEAD <sha>`, exit 0 — the common case for
 * this repo's own landing transport, `pr-land.mjs`'s default `--method=merge --no-ff`, a REAL merge commit
 * whose second parent IS the lane's own tip) OR patch-equivalent to it (round-1 convergence correctness
 * finding, #xkk4lv7): a squash or rebase merge reports a merge commit with NO ancestry relationship to the
 * original branch's own commits at all, even though the PR is genuinely, fully landed — the identical problem
 * `lane-pool.mjs`'s own `aheadIsProvablyPushed`/`cherryAllPatchEquivalent` already solve for the mirror-image
 * direction (a lane's own commit vs. MANY remote heads) — MIRRORS that file's `git cherry <upstream> <head>`
 * first tier (round-3 convergence, simplicity finding: this is NOT an import, and the claim below is corrected
 * from an earlier draft that overstated it as one). It cannot be a real import: `lane-pool.mjs` already imports
 * FROM `lease-reaper.mjs` (this file), so the reverse would cycle, and `cherryAllPatchEquivalent` is private to
 * that file besides. #4313 extracted the shared OUTPUT-PARSE primitive both files now import
 * (`../lib/git-patch-equivalence.mjs#isCherryOutputAllPatchEquivalent`) — each file still runs its own `git
 * cherry` spawn (this file's own `null`/`false` contract and `--` separator are unchanged), only the "every
 * line is `-`, or there are none" parse is single-sourced. `false` only on the DEFINITIVE negative (HEAD
 * carries commits beyond `sha`, proven both ways); `null` (unknown) on anything else (an unresolvable `sha`, a
 * git-read failure) — never guess "contained" from an inconclusive read.
 *
 * ONE SUCH "unresolvable `sha`" CASE, NAMED EXPLICITLY (round-4 convergence, correctness finding): `sha`
 * (a merged PR's own `mergeCommit.oid`, from a live `gh pr list` read) is a claim about GitHub's own state, not
 * a proof the object has been `git fetch`ed into THIS lane's (or its `--reference`d) local object database yet
 * — `gh` and `git` are two independent systems that can race. Both `merge-base --is-ancestor` and `git cherry`
 * fail loudly (a non-zero, non-"1" exit) on a `sha` they cannot resolve locally, which this function already
 * reads as `null` (never a guess) — so a fetch-lag race degrades to the SAME safe "don't corroborate yet, ride
 * the TTL backstop" outcome the closed-without-merge case above deliberately accepts, never a false reap. No
 * fetch is attempted here on purpose: this file already shares one pool-wide `gh pr list` read per pass
 * (`fetchPrStatesForRepo`) specifically to avoid a per-candidate network call, and a per-candidate `git fetch`
 * would reintroduce exactly that cost for a race that self-heals within one quiet window either way (this pool
 * fetches routinely via `acquire`/`refresh`/`provision`, all independent of this reap pass).
 *
 * #4337 — THE CHERRY FALLBACK'S OWN BLIND SPOT: `git cherry` is a per-commit patch-id comparison, and a merge
 * commit simply never surfaces in its output as a distinguishable patch (neither `+` nor `-`) — so a HEAD whose
 * *non-merge* commits are all independently patch-equivalent upstream, but whose HEAD is ALSO a merge commit
 * carrying unique conflict-resolution content `sha` never received, reads as empty/all-`-` — falsely
 * "contained" (CONFIRMED live on PR #2835). An empty/all-`-` cherry read is therefore necessary but not
 * sufficient: before trusting it, this function also vetoes on any merge commit reachable from HEAD but NOT
 * from `sha` (`git rev-list --merges`, bounded to that range) — existence alone is disqualifying, since a
 * merge's unique content can't be represented as a `cherry`-comparable patch at all. This veto can only ever
 * turn a would-be `true` into `false`/`null`, never the reverse: it runs strictly AFTER cherry already read
 * "contained", and a read failure there (an unresolvable `sha`, a timeout) is — per this function's own
 * contract — `null` (unknown), never a guess in either direction.
 *
 * DELIBERATE, DISCLOSED OVER-REJECTION (round-1 convergence, correctness finding): this vetoes on a merge
 * commit's mere EXISTENCE in the unaccounted range, not on detecting whether that specific merge carries unique
 * content — a routine, content-free `git merge main` a lane runs purely to stay fresh trips the SAME veto as a
 * real conflict-resolution merge, even though it adds nothing of its own. Distinguishing the two would mean
 * trusting some per-commit "this merge's diff is trivial" heuristic — exactly the kind of inference that let
 * the original bug through `cherry` in the first place. Given the choice, this stays on the safe side: a false
 * "not contained" costs a delayed reclaim (self-heals: the TTL backstop and every other reap axis still apply);
 * a false "contained" costs real, lost work. See the `#4337 — a routine, CONTENT-FREE merge …` fixture in
 * `__tests__/lease-reaper.test.mjs` for this exact tradeoff pinned as an intentional test, not an unnoticed
 * side effect.
 *
 * #4339 — AGGREGATE-CONTAINMENT TIER (multi-commit squash): a GitHub squash of a lane with N>1 commits lands as
 * ONE upstream commit whose patch-id equals none of the N lane commits, so `git cherry` prints N `+` lines even
 * though the PR is fully landed. When cherry reports `+` lines (and no unaccounted merge commit exists in
 * `sha..HEAD` — the veto above now runs on both paths), this compares the first token of `git patch-id --stable`
 * over the lane's net diff (`merge-base HEAD sha`..HEAD) with that of `sha`'s own single-parent diff. Both ids
 * must be non-empty and equal (`patch-id` prints nothing for an empty diff, so two empties never match); a
 * merge `sha` skips the tier (`false`); any git-read failure is `null`. NOTE: `patch-id` ignores whitespace, so
 * "equal" means patch-equivalent, not byte-identical — still the safe direction, since it only turns `false`
 * into `true` when the lane's whole change matches a single-parent upstream commit.
 */
export function defaultGitIsAncestor(dir, sha, { exec = execFileSync } = {}) {
  try {
    // #xkk4lv7 — round-5 convergence (security finding): `sha` is DATA (a live `gh pr list` read's
    // `mergeCommit.oid`), never a caller-typed literal like `'HEAD'` — the trailing `--` is git's own
    // universal options/revisions separator, so a `sha` value that happened to start with `-` (a malformed
    // API response, or any future caller feeding this untrusted input) can never be misread as a flag.
    exec('git', ['merge-base', '--is-ancestor', '--', 'HEAD', sha], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: resolveChildTimeoutMs(),
      killSignal: 'SIGKILL',
    });
    return true;
  } catch (e) {
    if (!(e && typeof e.status === 'number')) return null; // spawn/timeout failure — never guess
    if (e.status !== 1) return null; // per git's own contract, anything but exit 1 is an ERROR, not "not an ancestor"
    // #xkk4lv7 — the squash/rebase-merge fallback: `git cherry <sha> HEAD` lists every commit HEAD carries
    // that `sha`'s own history lacks, prefixed `-` when an equivalent patch already exists in `sha`'s history,
    // `+` when it does not. Empty (or all `-`) means every one of HEAD's own commits is already reflected in
    // the merge, patch-for-patch — "already landed" even with zero shared ancestry.
    let cherryContained;
    try {
      const out = exec('git', ['cherry', '--', sha, 'HEAD'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: resolveChildTimeoutMs(),
        killSignal: 'SIGKILL',
      });
      // #4313 — the parse below is the shared primitive; the spawn above (options, `--` separator) stays local.
      cherryContained = isCherryOutputAllPatchEquivalent(out);
    } catch {
      // #xkk4lv7 — round-2 convergence (standards-conformance finding): this function's own docblock promises
      // `null` (unknown, never guess) for an inconclusive read — `cherry` itself throwing (a timeout, an
      // unresolvable `sha`) is exactly that, NOT the definitive negative the ancestor check's own exit-1 means.
      // Was `false`; harmless today (the one caller, `laneQuietSincePr`, treats `false`/`null` identically —
      // both mean "not reaped") but wrong per the documented three-way contract, and a future caller that
      // DOES distinguish "proven not contained" from "unknown" deserves the honest answer.
      return null;
    }
    // #4337 — cherry alone is not proof of containment either way: veto if HEAD's history holds a merge
    // commit `sha`'s history lacks. `--max-count=1` — existence is all that matters, not the full list.
    // `--end-of-options` (never a bare `--` ahead of the range) keeps this a REVISION range, not a pathspec —
    // `rev-list`, unlike `merge-base --is-ancestor`/`cherry` above, treats anything after a bare `--` as a
    // path, so this exact separator choice is load-bearing, not cosmetic; the trailing `--` with nothing after
    // it is the explicit, standard "no path filter" spelling.
    // #4339 — this veto now runs on BOTH the cherry-contained and the cherry-unmatched (`+`) paths, since the
    // aggregate tier below must never accept a lane whose history carries an unaccounted-for merge commit.
    const gitRead = (args) => exec('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: resolveChildTimeoutMs(),
      killSignal: 'SIGKILL',
    });
    try {
      const mergeOut = gitRead(['rev-list', '--merges', '--max-count=1', '--end-of-options', `${sha}..HEAD`, '--']);
      if (mergeOut.trim().length !== 0) return false; // an unaccounted-for merge commit — never "contained"
    } catch {
      return null; // inconclusive range read (unresolvable sha, timeout) — never guess, same contract as above
    }
    if (cherryContained) return true;
    // #4339 — AGGREGATE TIER: cherry printed `+` lines, but a squash of N>1 lane commits is ONE upstream commit
    // whose patch-id matches none of them individually. Compare the lane's whole net diff against `sha`'s own
    // diff instead. Only a single-parent `sha` qualifies (a merge `sha`'s diff is not a squash's).
    try {
      const parents = gitRead(['rev-list', '--parents', '-n1', '--end-of-options', sha, '--']).trim().split(/\s+/);
      if (parents.length !== 2) return false; // a merge (or root) `sha` — the tier does not apply
      const base = gitRead(['merge-base', '--', 'HEAD', sha]).trim();
      if (!base) return null;
      const stablePatchId = (from, to) => {
        const diff = gitRead(['diff', '--no-ext-diff', '--end-of-options', from, to, '--']);
        const id = exec('git', ['patch-id', '--stable'], {
          cwd: dir,
          input: diff,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: resolveChildTimeoutMs(),
          killSignal: 'SIGKILL',
        });
        return id.trim().split(/\s+/)[0] || '';
      };
      const laneId = stablePatchId(base, 'HEAD');
      const landedId = stablePatchId(parents[1], sha);
      // `patch-id` prints nothing for an empty diff — two empties must NOT read as equal.
      return laneId !== '' && landedId !== '' && laneId === landedId;
    } catch {
      return null; // any git-read failure in the aggregate tier — unknown, never a guess
    }
  }
}

/** Fork 2/Option C's conservative quiet window (this card's Decided design) — well short of the existing
 *  4-hour {@link DEFAULT_LEASE_TTL_MINUTES} TTL, since this axis has NO positive liveness signal at all for its
 *  population (see {@link laneQuietSincePr}'s own doc) and can only ever bound the exposure window, never prove
 *  the holder is gone. */
export const DEFAULT_QUIET_MS = 30 * 60_000;

/**
 * Fork 2/Option C's safety gate (this card's Decided design, round-3 final shape): may a branch-derived
 * `pr-merged`/`pr-closed` verdict be TRUSTED for a lease whose `session` names no dispatcher grammar at all
 * (the sole population {@link laneBranchItemNum} exists for)? `true` only when ALL of:
 *   1. the lane's working tree is CLEAN (`git status --porcelain` empty) — a dirty tree is a live worker's own
 *      uncommitted change, never reapable;
 *   2. HEAD is an ancestor-or-equal of the PR's own merge commit — HEAD carrying commits BEYOND the merge is
 *      live, un-landed work in the same lane, never reapable (rules out the "old branch, new work" shape #9's
 *      light-review round found);
 *   3. `nowMs` is at least `quietMs` past the LATER of the PR's own `mergedAt` and this lease's own
 *      `acquiredAt` — anchoring to the LATER of the two (never `mergedAt` alone) is what closes round 3's gap:
 *      a lease acquired FRESH against an old-merged branch always gets its own full quiet window from
 *      `acquiredAt`, regardless of how long ago the PR merged.
 * `null` (never a guess) on any git-read failure, or when `prMergeSha`/`prMergedAt`/`leaseAcquiredAt` is
 * missing or unparseable — mirrors every other axis in this file's fail-closed contract. This can only ever
 * SHRINK the reap-exposure window (from "up to 4 hours" down to "up to ~`quietMs` since whichever of merge-or-
 * acquire happened last") — it never claims to prove the holder is gone, since this population has no positive
 * liveness signal at all (today's `sessionGoneForLease`/`pidAliveForLease` are BOTH gated on a recognized
 * dispatcher-minted session name, which is precisely what this lease lacks).
 * @param {string} dir - the lane's working-tree path.
 * @param {{prMergeSha:string|null, prMergedAt:string|null, leaseAcquiredAt:string|null, nowMs:number,
 *   quietMs?:number, statusPorcelain?:(dir:string)=>(string|null), isAncestor?:(dir:string,sha:string)=>(boolean|null)}} o
 * @returns {boolean|null}
 */
export function laneQuietSincePr(dir, {
  prMergeSha,
  prMergedAt,
  leaseAcquiredAt,
  nowMs,
  quietMs = DEFAULT_QUIET_MS,
  statusPorcelain = defaultGitStatusPorcelain,
  isAncestor = defaultGitIsAncestor,
} = {}) {
  if (typeof prMergeSha !== 'string' || !prMergeSha) return null;
  if (typeof nowMs !== 'number') return null;
  const mergedAtMs = Date.parse(prMergedAt);
  const acquiredAtMs = Date.parse(leaseAcquiredAt);
  if (Number.isNaN(mergedAtMs) || Number.isNaN(acquiredAtMs)) return null; // missing/unparseable — never guess
  const porcelain = statusPorcelain(dir);
  if (porcelain === null) return null; // unreadable tree — can't confirm clean, never guess
  if (porcelain.trim() !== '') return false; // dirty — a live worker's own uncommitted change, never reap
  const ancestor = isAncestor(dir, prMergeSha);
  if (ancestor === null) return null; // unresolvable — never guess
  if (ancestor === false) return false; // HEAD carries new commits beyond the merge — live, un-landed work
  return nowMs - Math.max(mergedAtMs, acquiredAtMs) >= quietMs;
}

/**
 * THE COMPOSED resolver (this card's Interfaces section) — `itemNumFromSession`/`prNumFromSession` first,
 * consulting the branch fallback ONLY when NEITHER resolves anything (Fork 1: a correctly-resolved PR-kind
 * lookup, e.g. `fix-900`, must never be silently overridden by an unrelated branch-derived item), and trusting
 * a terminal branch-derived verdict only once Fork 2/Option C's corroboration holds (an open branch PR needs
 * no extra corroboration — "open wins" already protects it, same as every other axis in this file). The ONE
 * seam both `main()`'s `signalsFor` (below) and `lane-pool.mjs`'s `deadLeasePlan` drive — never a second,
 * independently-maintained copy of this order (this card's Risk 5).
 *
 * NOTE ON `'closed'` PRs (round-2/round-3 convergence, correctness + standards-conformance + claim-accuracy):
 * a PR closed WITHOUT merging carries no `mergeCommit` at all (`sha` is `null` in `repoStates.detailsByItem`),
 * so `laneQuietSincePr` — which requires a merge sha to check containment against — can never corroborate it:
 * `corroborated` is always `false`, so `itemNum` and `itemNumSource` both stay their initial `null` (NEVER
 * `'branch-uncorroborated'` — that tier is reserved for an OPEN PR or no PR at all, where "open wins" already
 * makes an uncorroborated guess harmless; a bare 'closed' guess earns no trust at all, not even the weaker
 * uncorroborated tier — pinned by this file's own `__tests__/lease-reaper.test.mjs`). This is a DELIBERATE,
 * DOCUMENTED gap, not a silent one: a lease whose branch names a closed-but-unmerged PR rides the pre-existing
 * TTL backstop, precisely as it did before this fix existed — this card's own live evidence (lane-2/lane-9) was
 * exclusively the MERGED shape, and inventing an unproven containment story for the merge-less closed case is
 * worse than leaving it exactly where it already was.
 * @param {object|null} lease
 * @param {string} dir - the lane's working-tree path.
 * @param {{repoStates?:{byItem?:Map, byPr?:Map, detailsByItem?:Map}|null, nowMs:number,
 *   quietMs?:number, git?:Function, statusPorcelain?:Function, isAncestor?:Function}} o
 * @returns {{itemNum:string|null, prNum:string|null, itemNumSource:('session'|'branch-corroborated'|'branch-uncorroborated'|null)}}
 */
export function resolveLeaseItemNum(lease, dir, { repoStates = null, nowMs, quietMs = DEFAULT_QUIET_MS, git, statusPorcelain, isAncestor, ownerAlive = null } = {}) {
  let itemNum = itemNumFromSession(lease?.session);
  const prNum = prNumFromSession(lease?.session);
  // #xkk4lv7 — round-1 convergence (standards-conformance + claim-accuracy, independently) — `itemNumSource`
  // tells a downstream caller HOW `itemNum` was resolved, because not every use is equally safe for every
  // consumer: `'session'` is a dispatcher-minted slug (always trustworthy — today's pre-existing contract).
  // `'branch-corroborated'` is a branch-derived guess whose merged/closed PR was ALSO corroborated by Fork
  // 2/Option C (clean tree + contained HEAD + quiet window) — safe for a PR-terminal lookup. `'branch-
  // uncorroborated'` is a branch-derived guess backed by an OPEN PR or NO PR AT ALL — "open wins" already makes
  // this harmless for the PR-terminal axis alone (an open/absent PR state never reaps anything), but it carries
  // ZERO tree-cleanliness/containment/quiet-window proof. `lane-pool.mjs`'s `deadLeasePlan` ALSO feeds `itemNum`
  // into a SECOND, independent terminal signal (`itemResolvedOnMain` — an offline backlog-card check that has
  // no corroboration story of its own), and reusing an uncorroborated branch guess there would let a lease on
  // a `lane/2500b-*` retry branch doing genuinely new work get reaped just because item 2500's ORIGINAL,
  // already-landed backlog card reads `resolved` — exactly the "old branch, new work" hazard Fork 2/Option C
  // exists to rule out, reached through a side door. `null` when `itemNum` is `null` (nothing resolved at all).
  let itemNumSource = itemNum != null ? 'session' : null;
  if (itemNum == null && prNum == null) {
    const branchNum = laneBranchItemNum(dir, { git });
    if (branchNum != null) {
      const branchDetail = repoStates?.detailsByItem?.get(branchNum) ?? null;
      if (branchDetail && (branchDetail.state === 'merged' || branchDetail.state === 'closed')) {
        // #4332 — liveness VETO (never a reap signal): a lease whose declared occupant is provably alive is not
        // reaped off a branch-derived merged/closed verdict, which rests on acquisition age + a quiet window
        // alone. Only exactly `true` vetoes; `false`/`null`/absent fall through to the quiet-window gate.
        // `ttl-stale`/`pid-dead` in classifyReap still apply.
        const corroborated = ownerAlive !== true && laneQuietSincePr(dir, {
          prMergeSha: branchDetail.sha,
          prMergedAt: branchDetail.mergedAt,
          leaseAcquiredAt: lease?.acquiredAt,
          nowMs,
          quietMs,
          statusPorcelain,
          isAncestor,
        }) === true;
        if (corroborated) {
          itemNum = branchNum;
          itemNumSource = 'branch-corroborated';
        }
      } else {
        // no PR at all, or a still-open one — "open wins" already protects the PR-terminal axis (an open/
        // absent PR state never reaps anything either way) — but NEVER treat this as corroborated for any
        // OTHER terminal signal a caller might drive off the same itemNum.
        itemNum = branchNum;
        itemNumSource = 'branch-uncorroborated';
      }
    }
  }
  return { itemNum, prNum, itemNumSource };
}

/**
 * The DETERMINISTIC reap verdict for ONE lease — pure, same signals → same verdict. A lease is reaped when it
 * is not reserved AND any axis fires; the reason names the axis (PR-terminal wins, then session-gone, then TTL,
 * then pid).
 *
 * @param {object|null} lease  the parsed `.lane-lease` marker.
 * @param {{nowMs:number, ttlMs?:number, prState?:('merged'|'closed'|'open'|null), sessionGone?:(boolean|null), pidAlive?:(boolean|null)}} sig
 *   `prState` = the terminal state of the lease's item PR (null = unknown, don't reap on this axis);
 *   `sessionGone` = whether the lease's owning delivery-agent SESSION is confirmed gone — absent from a fresh
 *     `claude agents --json --all` listing, or present in a terminal state (null = unknown/no dispatcher-minted
 *     session name to check → axis dormant for this lease, see {@link sessionGoneForLease});
 *   `pidAlive` = whether the owning agent process is alive (null = unknown/untrustworthy → axis dormant).
 * @returns {{reap:boolean, reason:('pr-merged'|'pr-closed'|'session-gone'|'ttl-stale'|'pid-dead'|'reserved'|null)}}
 */
export function classifyReap(lease, { nowMs, ttlMs = DEFAULT_LEASE_TTL_MINUTES * 60_000, prState = null, sessionGone = null, pidAlive = null } = {}) {
  if (!lease || typeof lease !== 'object') return { reap: false, reason: null };
  // #2350 — a RESERVED (permanent) lane is the durable memory slot; it is off-limits to reclamation on EVERY
  // axis. Short-circuit BEFORE any other test so no signal can ever collect it.
  if (isReservedLease(lease)) return { reap: false, reason: 'reserved' };
  // PR-terminal wins: the work is done (merged) or abandoned (closed), so the lane is free even pre-TTL.
  if (prState === 'merged') return { reap: true, reason: 'pr-merged' };
  if (prState === 'closed') return { reap: true, reason: 'pr-closed' };
  // session-gone: the delivery agent's OWN session is confirmed dead/absent — the real fix for the 2026-09-04/05
  // incident (a session dies mid-build with no PR ever opened, so the PR axis above never fires). Checked BEFORE
  // TTL so a confirmed-dead lease reclaims EARLY, not after the full 4-hour wait, and reports its true reason.
  if (sessionGone === true) return { reap: true, reason: 'session-gone' };
  // TTL-stale: the owner outlived its heartbeat — the zero-IO dead-agent backstop for everything the two axes
  // above couldn't confirm (no PR yet, no readable session listing, or a non-dispatcher session name).
  if (isLeaseStale(lease, nowMs, ttlMs)) return { reap: true, reason: 'ttl-stale' };
  // pid-dead: only fires when the shell supplies a TRUSTWORTHY liveness (dormant today — see pidAliveForLease).
  if (pidAlive === false) return { reap: true, reason: 'pid-dead' };
  return { reap: false, reason: null };
}

/**
 * Reduce a parsed `gh pr list` array → a Map of item-num → PR state, keyed by matching each PR's head ref
 * `lane/<num>-*`. PURE (no gh) so the risky reduction is unit-tested directly. SAFETY: **open WINS** — if a
 * number has ANY open PR, the number reads `'open'` (never reaped on the PR axis), because both this and
 * `itemNumFromSession` collapse a retry suffix (`lane/2500b-*` → `2500`), so a still-live retry PR must never
 * be overwritten by an OLDER terminal PR of the same base number — that would `release --force` a LIVE lane
 * (the #2267 data-loss hazard). Among terminal-only numbers, `merged` wins over `closed` (the work landed).
 * Priority: open > merged > closed.
 * @param {Array<{headRefName?:string, state?:string, mergedAt?:string|null}>} prs
 * @returns {Map<string,'open'|'merged'|'closed'>}
 */
const PR_STATE_RANK = { open: 3, merged: 2, closed: 1 };

/**
 * #4415 — normalize one `GET /repos/{o}/{r}/pulls` REST list item into the shape {@link reduceDetails} (and its
 * `prStatesFromList`/`prStatesByPrNumber`/`prDetailsFromList` callers) already read: REST nests the branch name
 * under `head.ref` (not a top-level `headRefName`) and reports the merge commit as a flat `merge_commit_sha`
 * string (not a nested `mergeCommit.oid`). `state`/`mergedAt`/`number` are already the same field names/shapes
 * REST and the old `gh pr list --json` GraphQL read both use, so they pass through unchanged.
 * TOLERANT of the pre-existing GraphQL-shaped fixtures every test in this file already hand-builds
 * (`headRefName`/`mergeCommit.oid` top-level, no `head`/`merge_commit_sha` at all) — `??` falls through to those
 * fields when the REST ones are absent, so this mapper is purely additive and no existing fixture needed to
 * change. PURE.
 * @param {object} p
 * @returns {{number:*, state:*, headRefName:string, mergedAt:string|null, mergeCommit:{oid:string}|null}}
 */
export function restPullToPrStateShape(p) {
  return {
    number: p?.number,
    state: p?.state,
    headRefName: p?.headRefName ?? p?.head?.ref ?? '',
    mergedAt: p?.mergedAt ?? p?.merged_at ?? null,
    mergeCommit: p?.mergeCommit ?? (p?.merge_commit_sha ? { oid: p.merge_commit_sha } : null),
  };
}

/** The one terminal-state-PLUS-detail reduction every keyed-by-X PR Map in this file shares (state-only
 *  `prStatesFromList`/`prStatesByPrNumber`, AND the detail-carrying `prDetailsFromList`, #xkk4lv7) — same
 *  "open wins, then merged over closed" priority, different key function, never two
 *  separately-maintained copies of the same rank table. Each entry carries `{state, sha, mergedAt}`: `sha` is
 *  the PR's merge commit (`null` for an open/closed-unmerged PR, or when `gh` didn't fetch `mergeCommit`) and
 *  `mergedAt` is its raw ISO string (or `null`) — both needed ONLY by {@link laneQuietSincePr}'s corroboration,
 *  never by the ordinary state-only lookups, which keep reading a plain state string via the thin wrappers
 *  below (byte-identical Map shape to before this file added the branch-fallback — no existing caller changes).
 */
function reduceDetails(prs, keyFor) {
  const byKey = new Map();
  for (const pr of Array.isArray(prs) ? prs : []) {
    const key = keyFor(pr);
    if (!key) continue;
    const s = String(pr?.state || '').toUpperCase();
    const state = pr?.mergedAt || s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open';
    const prev = byKey.get(key);
    if (!prev || PR_STATE_RANK[state] > PR_STATE_RANK[prev.state]) {
      // open wins; then merged over closed — same rank table every reduction here shares
      byKey.set(key, { state, sha: pr?.mergeCommit?.oid ?? null, mergedAt: pr?.mergedAt ?? null });
    }
  }
  return byKey;
}

/** State-only VIEW over {@link reduceDetails} — the pre-#xkk4lv7 return shape (`Map<string,'open'|'merged'|
 *  'closed'>`), kept byte-identical so `prStatesFromList`/`prStatesByPrNumber` never change under any existing
 *  caller or test. */
function reduceTerminalStates(prs, keyFor) {
  const details = reduceDetails(prs, keyFor);
  return new Map([...details].map(([k, v]) => [k, v.state]));
}

export function prStatesFromList(prs) {
  return reduceTerminalStates(prs, (pr) => laneRefItemNum(pr?.headRefName));
}

/**
 * #xkk4lv7 — {@link prStatesFromList}'s DETAIL-carrying twin: same item-num key (a PR's head ref `lane/<num>-*`),
 * same open/merged/closed priority, but each entry is `{state, sha, mergedAt}` rather than a bare state string.
 * The ONLY consumer today is {@link laneQuietSincePr}'s corroboration via {@link resolveLeaseItemNum} — a
 * branch-derived item guess needs the PR's own merge commit sha (to check HEAD is contained in it) and its
 * `mergedAt` (to anchor the quiet window), neither of which the state-only Map ever carried.
 * @param {Array<{headRefName?:string, state?:string, mergedAt?:string|null, mergeCommit?:{oid?:string}}>} prs
 * @returns {Map<string,{state:'open'|'merged'|'closed', sha:string|null, mergedAt:string|null}>}
 */
export function prDetailsFromList(prs) {
  return reduceDetails(prs, (pr) => laneRefItemNum(pr?.headRefName));
}

/**
 * Reduce a parsed `gh pr list` array → a Map of PR-NUMBER → terminal state — the namespace a PR_KIND session
 * (`review-`/`fix-`/`ci-heal-`/`inspect-<PR>`, via {@link prNumFromSession}) actually names, DISTINCT from
 * {@link prStatesFromList}'s item-number-keyed Map (via a PR's head ref). #x5wm9ot: before this, the ONLY
 * PR-state Map any caller had was the head-ref-keyed one, so a `fix-<PR>` session's PR-terminal check used the
 * PR's own number as a key into a Map keyed by a DIFFERENT number (the couple's item id) — right only by
 * coincidence. Same "open wins" safety as `prStatesFromList` — a live retry PR opened under the SAME number
 * (`gh` never reuses a PR number) can't arise, so this needs no retry-suffix collapse.
 * @param {Array<{number?:number, state?:string, mergedAt?:string|null}>} prs
 * @returns {Map<string,'open'|'merged'|'closed'>}
 */
export function prStatesByPrNumber(prs) {
  return reduceTerminalStates(prs, (pr) => (pr?.number != null ? String(pr.number) : null));
}

/**
 * The `claude agents --json --all` states this reaper treats as "not doing any more work" for a lease's owning
 * session — the SAME terminal vocabulary `session-reaper.mjs` (WE #3435) already measured live and reaps on:
 * `TERMINAL_REAP_STATES` (`done`/`failed`) plus `ALREADY_STOPPED_STATES` (`stopped`). Kept as a local constant
 * rather than importing `session-reaper.mjs`'s sets — this file has no other dependency on that module, and the
 * three literal strings are the entire cross-file agreement; duplicating three string literals costs far less
 * than a coupling between two independently-runnable mechanical passes.
 */
export const AGENT_GONE_STATES = new Set(['done', 'failed', 'stopped']);

/**
 * Reduce a `claude agents --json --all` listing → a Map of session `name` → its own `state`, background rows
 * only. Pure (no exec) so the risky reduction is unit-tested directly, mirroring {@link prStatesFromList}'s
 * split. `kind !== 'background'` rows (a human's own interactive terminal session) are excluded — mirrors
 * `session-reaper.mjs`'s own absolute guard, and matters here because an interactive session's `name` is never
 * dispatcher-minted but nothing stops it coincidentally colliding with one.
 *
 * #x2psfwz — DUPLICATE NAMES NEVER LET A TERMINAL ROW MASK A LIVE ONE. A PR_KIND session name (`review-`/
 * `fix-`/`ci-heal-`/`inspect-<PR>`) carries no attempt suffix, so a round-2 dispatch for the same PR reuses the
 * exact name round 1 used — and this listing can legitimately carry TWO rows for that one name (a round-1 row
 * `claude agents` has not pruned yet, and round-2's own live one), in an order this CLI documents nowhere. This
 * used to be a bare `.set()` per row, so whichever row happened to come LAST in the array won — a live round-2
 * session could be masked as `done`/`failed`/`stopped` by a stale round-1 duplicate that simply sorted after
 * it, entirely by listing order, not recency. Now a TERMINAL reading never overwrites a LIVE one already
 * recorded for the same name (a live-over-live or terminal-over-terminal overwrite is harmless either way, so
 * this is the one asymmetric case that needs guarding).
 * @param {Array<{kind?:string, name?:string, state?:string}>} sessions
 * @returns {Map<string,string|null>}
 */
export function sessionStateByName(sessions) {
  const byName = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object' || s.kind !== 'background') continue;
    if (typeof s.name !== 'string' || !s.name) continue;
    const state = s.state ?? null;
    if (byName.has(s.name)) {
      const existingIsLive = !AGENT_GONE_STATES.has(byName.get(s.name));
      const newIsTerminal = AGENT_GONE_STATES.has(state);
      if (existingIsLive && newIsTerminal) continue; // keep the live reading; a duplicate terminal row never masks it
    }
    byName.set(s.name, state);
  }
  return byName;
}

/**
 * {@link sessionStateByName}, DEGRADED to axis-off (`null`) when the reduction yields ZERO background rows.
 * Independent-review finding on PR #1921 (correctness, PLAUSIBLE, filed as prevention): a `claude agents --json
 * --all` call that exits 0 with a valid-but-empty/incomplete JSON array — never observed live, but the exact
 * class of unverified-CLI-surface risk backlog #3353 already raised for other `claude agents` readers — would
 * otherwise make {@link sessionGoneForLease} read EVERY dispatcher-named lease's session as "not listed, so
 * gone", mass-reaping the whole fleet in one pass on a single bad read — the very failure mode the operator's
 * manual force-release was mitigating, now automated. An all-empty read is indistinguishable from that glitch
 * (there is no third state a `claude` CLI could return to say "this really is legitimately zero"), so it is
 * treated exactly like a thrown/unparsable listing: the axis degrades OFF for this pass and TTL-stale still
 * bites. The one real cost is a rare degraded tick when truly nothing is currently dispatched — a confirmed-dead
 * lease from that tick simply waits for the very next tick (once anything else is dispatched and the listing is
 * non-empty again) or its TTL, never longer.
 * @param {Array<{kind?:string, name?:string, state?:string}>} sessions
 * @returns {Map<string,string|null>|null}
 */
export function sessionStatesForReap(sessions) {
  const byName = sessionStateByName(sessions);
  return byName.size === 0 ? null : byName;
}

/**
 * #3383 (2026-09-14 incident) — REAL PROCESS liveness for every background listing row, keyed by `name`. Pure —
 * mirrors {@link sessionStateByName}'s own reduction (background rows only), but resolves `pidAlive` instead of
 * `state`, through the SAME two-signal probe `driver-watchdog.mjs`'s own `resolvePidAlive` already established
 * (a row's own `pid` when present, else a `ps aux` scan for its full `sessionId`). `psOutput` is the raw `ps aux`
 * capture (or `null` when the scan itself failed/was skipped — every row then resolves to `null`, i.e. unknown,
 * never a false death) taken ONCE for the whole listing, not per row.
 * @param {Array<{kind?:string, name?:string, pid?:number|null, sessionId?:string|null}>} sessions
 * @param {{psOutput?:string|null, isPidAlive?:(pid:number)=>boolean}} [o]
 * @returns {Map<string, boolean|null>} session `name` → `pidAlive` (`true`/`false` when established, `null` when
 *   neither probe could say).
 */
export function sessionPidAliveByName(sessions, { psOutput = null, isPidAlive = defaultIsPidAlive } = {}) {
  const byName = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object' || s.kind !== 'background') continue;
    if (typeof s.name === 'string' && s.name) byName.set(s.name, resolvePidAlive(s, { psOutput, isPidAlive }));
  }
  return byName;
}

/**
 * #xbk2is9 — is the lease's DECLARED OCCUPANT (`workerSession` — the session actually working the lane, stamped
 * by `--adopt`/`adopt`, #2997 r2) confirmed ALIVE in the SAME `claude agents --json --all` listing
 * {@link sessionGoneForLease}'s other axes already read? THE INCIDENT: a delivery agent started BY HAND (an
 * in-process Agent-tool subagent, `we:skills-src/conveyor/delivery-agent-brief.md`, never `claude --bg`) still
 * acquires with `--session=conveyor-<N>` — a name {@link sessionGoneForLease} looks up in the listing, but an
 * in-process subagent is never listed under its own manufactured name, so past the grace window this read as
 * "never listed → gone" (measured across ~10 lanes, this card's Evidence section). This brief's own step 1
 * (`acquire ... --adopt`) stamps `workerSession` to the CALLING session's own id (the subagent runs IN-PROCESS,
 * so it has no session identity distinct from its parent) — a real, live, listed row this function can find.
 *
 * ONLY `workerSession` IS CHECKED — narrower than the reclaim salvage gate's own
 * {@link liveAgentInLane}(agents, dir, [ownerSession, workerSession, session]) (`cmdReclaim --salvage`), which
 * first confirmed this exact lease's liveness and which this card's own Fork 1 text names checking alongside it.
 * `ownerSession` (whoever ran `acquire`, #2997) is excluded ON PURPOSE (round-4 convergence, correctness finding):
 * in the PRODUCTION dispatch path the DISPATCHER leases the lane itself (no `--adopt`) and the delivery agent
 * adopts it separately once spawned, so `ownerSession` is the dispatcher's own long-lived, essentially
 * ALWAYS-alive id — checking it would read nearly every held lease as "alive" regardless of whether the actual
 * delivery agent is, silently neutering this axis for the everyday `claude --bg` population it exists to catch.
 * The reclaim gate can afford that breadth because it answers a DIFFERENTLY-RISKED question ("safe to reset?",
 * where a false "someone's here" only delays a reset); a false "alive" here actively suppresses a real reap, the
 * opposite risk direction. `session` (the lease's own dispatcher-grammar name) is excluded too: a `conveyor-<N>`
 * slug never coincidentally collides with a real `sessionId`, so checking it adds no coverage.
 *
 * KNOWN, ACCEPTED TRADE-OFFS (this card's own Fork 1 rejected the alternatives that would close any of these):
 *   - `workerSession` ITSELF can still be shared: for a hand-briefed subagent it IS the parent interactive
 *     session's id, and one interactive session may dispatch several subagents (several leases) at once, or
 *     stay open long after any one of them finishes — so this check can read a genuinely finished subagent's
 *     lease as "alive" as long as its parent session is. Narrower than the `ownerSession` breadth above (a
 *     dispatcher juggles orders of magnitude more leases than one interactive session's own subagents), but the
 *     same shape, not a different one — {@link sessionGoneForLease} restricts this check to its absence branch
 *     for exactly this reason, so a real terminal-state/`pidAlive` read is never overridden by it.
 *   - A lease never `adopt`ed (`workerSession` absent) has no signal here at all → `null`, falling through to
 *     the pre-existing absence/age logic UNCHANGED — the safe default when there is no reliable worker signal.
 *   - {@link liveAgentInLane}'s `cwd` fallback (below) counts ANY live, non-terminal row whose `cwd` is this lane
 *     as alive, even with no matching `sessionId` — real evidence, and the dispatcher's own cwd is never the
 *     individual worker's lane dir, so it doesn't reintroduce the `ownerSession` breadth problem above.
 *   Closing any of these fully would need a durable per-delivery-agent liveness signal this schema does not have
 *   (the same gap `pidAliveForLease`'s own docblock names for `lease.pid`) — out of scope for this fix.
 *
 * `null` (never guess) when the lease carries no `workerSession` at all, or when `agents` isn't an array (the
 * listing was unavailable this pass — same fail-closed contract every other axis in this file already shares).
 * Otherwise defers entirely to {@link liveAgentInLane}'s own contract: `true` only when a listed, NON-terminal
 * row's `sessionId` is `workerSession` OR its `cwd` is this lane — never a guess in either direction.
 *
 * @param {object|null} lease
 * @param {Array<object>|null} agents - a `claude agents --json --all` listing (background AND interactive rows
 *   alike — unlike {@link sessionStateByName}, this deliberately does NOT filter to `kind === 'background'`,
 *   since the whole point is to find the OWNING INTERACTIVE session a hand-briefed subagent's own listing row
 *   can never carry).
 * @param {string} dir - the lane's working-tree path (for {@link liveAgentInLane}'s cwd fallback).
 * @returns {boolean|null}
 */
export function ownerSessionAliveForLease(lease, agents, dir) {
  const workerSession = lease && typeof lease.workerSession === 'string' ? lease.workerSession : null;
  if (!workerSession) return null; // no declared occupant recorded on this lease — nothing to check
  if (!Array.isArray(agents)) return null; // listing unavailable this pass — unknown, never guess
  return liveAgentInLane(agents, dir, [workerSession]);
}

/**
 * Is the delivery agent a lease's own `session` names CONFIRMED gone? THE FIX for the 2026-09-04/05 incident
 * (`conveyor-3466` on lane-38, `conveyor-2412`/`conveyor-2412c` on lane-40): both sessions died/disappeared
 * ENTIRELY from `claude agents --json` — not merely reported `done`/`failed`, simply no longer listed at all,
 * confirmed independently via `ps -p <pid>` on the underlying OS process — while their lane leases sat held for
 * hours, because neither the PR axis (no PR was ever opened) nor the TTL axis (nowhere near its 4-hour mark) had
 * anything to reclaim them with.
 *
 *   true  — a REAL, direct liveness read says the process is gone (`pidAlive === false`, see below and #3383's
 *           widening), OR `sessionStates` doesn't list this session at all AND the lease is past the {@link
 *           DISPATCH_GUARD_LISTING_GRACE_MINUTES} grace window (see below), OR the session IS listed in one of
 *           {@link AGENT_GONE_STATES} (`done`/`failed`/`stopped`) — the same three states `session-reaper.mjs`
 *           already reaps on. Any of these three and the session is provably not going to do any more work.
 *   false — the session IS listed, its state is none of the terminal ones (`working`/`blocked`/undefined), and
 *           either no `pidAlive` signal was supplied or it read `true`/`null` — a slow build, not a dead one.
 *   null  — never guess: `lease.session` matches no dispatcher-minted grammar ({@link itemNumFromSession}), so
 *           it was never spawned via `claude --bg` and would legitimately never appear in this listing (a
 *           manually-acquired or interactive lane) — absence there proves nothing about it. Also null when
 *           `sessionStates` itself isn't a Map (the listing was unavailable/all-empty this pass — axis off, see
 *           {@link fetchSessionSignals} / {@link sessionStatesForReap}), OR when the lease is absent from the
 *           listing but still inside its grace window and so too young to judge (see below) — a slow-to-list
 *           session is left `null`, not asserted alive, since nothing here actually confirms that either.
 *
 * THE PHANTOM-LISTING WIDENING (#3383, 2026-09-14 incident — the SAME shape `driver-watchdog.mjs` fixed for the
 * driver's own queue-claim check, just found again here). A session can be LISTED, in a non-terminal state,
 * with NO backing OS process at all — the CLI's own job-directory bookkeeping simply never noticed the process
 * died (the decay `we:scripts/operations/clear-stuck-session.mjs`'s header documents). Neither the absence
 * branch nor {@link AGENT_GONE_STATES} catches that: the row IS present, and its stuck `state` is whatever it
 * last wrote, never transitioning to `done`/`failed`/`stopped` on its own. `pidAlive` is the caller's REAL,
 * DIRECT process-liveness read for this exact session ({@link sessionPidAliveByName}, the SAME two-signal probe
 * `driver-watchdog.mjs`'s own `resolvePidAlive` uses) and is checked FIRST, before either the absence or the
 * listed-state branch: `pidAlive === false` is a positive, independent death signal that fires regardless of
 * what the listing's own `state` field says or how young the lease is — it needs no grace window, because it is
 * not an inference from silence the way absence is. `pidAlive === true` or `null` (unknown — no `sessionId` to
 * scan, or the `ps aux` scan itself failed) changes nothing: the existing listed/absent logic below still runs.
 *
 * THE GRACE WINDOW — independent-review finding on PR #1921 (security/concurrency-race, CONFIRMED). `claude
 * --bg` returns before its session is necessarily visible in `claude agents --json --all`
 * (`dispatch-lane.mjs`'s own `DISPATCH_LISTING_GRACE_MINUTES`/`DISPATCH_GUARD_LISTING_GRACE_MINUTES` measure
 * this exact lag), and a delivery agent's OWN first act is acquiring its lane (this lease). So a lease acquired
 * moments ago can legitimately have a session that simply is not listed YET — not a dead one. Reaping on that
 * absence force-releases a live lane before its agent has committed anything, and the very next `acquire` can
 * hand the SAME lane to a second agent while the first is still writing to it: two agents racing one working
 * tree, the exact #3283 failure ("the lease reaper reclaims a lane seconds after it is acquired") reintroduced
 * through this new axis. This reuses {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES} (10 minutes) rather than the
 * observer's smaller `DISPATCH_LISTING_GRACE_MINUTES` (2 minutes) DELIBERATELY: that constant's own docblock
 * picks its window by the COST of being wrong, and a wrong guard answer here is the identical failure shape
 * (releases a lane a live agent still holds) the guard constant was calibrated for — not the observer's cheap
 * "reports unresolved, writes nothing" mistake. The grace check applies ONLY to the absence branch: a session
 * that IS listed with a terminal state is a direct, positive observation, not an inference from silence, so it
 * needs no age check.
 *
 * WHY A LISTED TERMINAL STATE OR AN AGED-OUT ABSENCE IS STILL SAFE EVEN ON A TRANSIENT MISS. A released-but-
 * still-live lane is not immediately destroyed: `lane-pool.mjs release` only drops the marker (`lane-lease.mjs`'s
 * own "a released lane is immediately re-issuable" note), and the NEXT `acquire` still refuses to reset a lane
 * carrying real uncommitted/unpushed work (`isLaneAcquirable`'s `dirtyOrAhead` guard, #2267) regardless of lease
 * state. Past the grace window that residual exposure is the same one the existing PR-terminal axis already
 * accepts for a possibly-stale `gh` read — a narrow pre-first-commit window, mirroring this file's own
 * precedent of reclaiming pre-TTL on an external signal rather than waiting out the full TTL on principle.
 *
 * @param {object|null} lease
 * @param {Map<string,string|null>|null} sessionStates  from {@link sessionStatesForReap}; null = axis off.
 * @param {{nowMs?:number, graceMs?:number, pidAlive?:boolean|null}} [o]  `nowMs` = the clock reading to age the
 *   lease against (no default — omitting it makes the absence branch always `null`, never guessing at an
 *   unknown age); `graceMs` defaults to {@link DISPATCH_GUARD_LISTING_GRACE_MINUTES}; `pidAlive` (#3383) = this
 *   session's REAL process-liveness read from {@link sessionPidAliveByName} (`null` when not supplied/unknown —
 *   exact back-compat with every pre-#3383 caller); `wrapperAlive` (#3903) = whether a DETACHED delivery
 *   wrapper the dispatcher started for this session is still running (see {@link detachedWrapperPidsBySession});
 *   `ownerAlive` (#xbk2is9) = whether the lease's declared occupant (`workerSession`) is confirmed alive in the
 *   same listing (see {@link ownerSessionAliveForLease}) — `null` when not supplied or unknown (back-compat with
 *   every pre-#xbk2is9 caller). Consulted ONLY in the absence branch below, and ONLY there: it can never override
 *   a REAL, direct death signal about this lease's own TRACKED session — `pidAlive === false`, or the session
 *   listed in a terminal state — because those are positive evidence about the actual worker, while
 *   `ownerAlive` is a proxy (`workerSession`) that can legitimately outlive the one delivery agent a lease was
 *   minted for — see {@link ownerSessionAliveForLease}'s own "known, accepted trade-offs" note
 *   for what this narrowing does and does not close.
 * @returns {boolean|null}
 */
export function sessionGoneForLease(lease, sessionStates, { nowMs, graceMs = DISPATCH_GUARD_LISTING_GRACE_MINUTES * 60_000, pidAlive = null, wrapperAlive = null, ownerAlive = null } = {}) {
  const session = lease && typeof lease.session === 'string' ? lease.session : null;
  // #3903 — A MECHANICAL DISPATCH'S LEASE IS HELD BY A DETACHED WRAPPER PROCESS, NOT A `claude --bg` SESSION.
  // `deliver-item-run.mjs` acquires the lane under the dispatcher's session slug and then runs its agent (Codex,
  // or a restricted `claude -p`) in the foreground of its own process, so that slug is NEVER in `claude agents`.
  // Without this check the absence branch below reads a live, hour-long build as "never listed → gone" once the
  // 10-minute grace passes and force-releases its lane mid-build. The wrapper's own pid (the run store's `pid:<n>`
  // handle) is the direct answer: alive means NOT gone, full stop. `false`/`null` change nothing — a dead
  // wrapper falls through to the ordinary absence logic, which is what reclaims its lane after it exits.
  if (wrapperAlive === true) return false;
  // #x5wm9ot — was `itemNumFromSession(session) === null`, which after that function narrowed to item-kind-only
  // now reads EVERY PR_KIND session (review-/fix-/ci-heal-/inspect-) as "not dispatcher-minted, don't guess" —
  // exactly the TTL-only fallback bug #2 named. `isDispatcherMintedSession` is the general recognized-name
  // gate this check actually means; it matches every kind `parseSessionSlug` accepts, item or PR alike.
  if (!session || !isDispatcherMintedSession(session)) return null; // not a dispatcher-minted name — don't guess
  if (!(sessionStates instanceof Map)) return null; // listing unavailable/all-empty this pass — axis off
  // #3383 — a REAL, direct death signal wins outright: no grace window (it is not an inference from silence),
  // and it fires even when the row is LISTED with a non-terminal state (the phantom shape neither branch below
  // can see — see the docblock above). Deliberately checked BEFORE `ownerAlive` — see the `ownerAlive` @param
  // doc above for why.
  if (pidAlive === false) return true;
  if (!sessionStates.has(session)) {
    // #xbk2is9 — A HAND-BRIEFED (in-process Agent-tool) DELIVERY AGENT'S LEASE IS HELD BY AN INTERACTIVE
    // SESSION, NOT A `claude --bg` ONE, so this exact `session` name is never separately listed even though it
    // matches the dispatcher grammar — see {@link ownerSessionAliveForLease}'s own doc for the incident and the
    // id set checked. This is the ONLY branch `ownerAlive` applies in (see the `ownerAlive` @param doc above).
    if (ownerAlive === true) return false;
    // Absence alone is ambiguous until the lease has outlived the listing's own visibility lag.
    if (typeof nowMs !== 'number') return null; // can't judge age — never guess
    const acquiredAtMs = Date.parse(lease?.acquiredAt);
    if (Number.isNaN(acquiredAtMs)) return null; // no readable acquire time — never guess
    if (nowMs - acquiredAtMs < graceMs) return null; // too young — not yet listed is not the same as gone
    return true; // aged past the grace window and still never listed — gone
  }
  // A listed row — terminal or not — is a DIRECT, positive observation about THIS session's own process,
  // never overridden by `ownerAlive` (same reasoning as the `pidAlive` ordering above).
  return AGENT_GONE_STATES.has(sessionStates.get(session));
}

/**
 * #3903 — PURE. Session slug → pid of the detached delivery wrapper the dispatcher started for it, read off run
 * records ({@link createFileRunStore}'s shape): every IN-FLIGHT effect whose durable handle is `pid:<n>` (the
 * shape `dispatch-providers/build.mjs` returns) and whose payload names its `sessionSlug`. A `claude --bg`
 * short-id handle is not a wrapper and is skipped — the listing already answers for those.
 *
 * @param {Array<{effects?: Array<{status?: string, handle?: string|null, payload?: {sessionSlug?: string}}>}>} runs
 * @returns {Map<string, number>}
 */
export function detachedWrapperPidsBySession(runs) {
  const bySession = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    for (const e of Array.isArray(run?.effects) ? run.effects : []) {
      if (e?.status !== 'in-flight') continue;
      const pid = detachedHandlePid(e.handle);
      const session = typeof e?.payload?.sessionSlug === 'string' ? e.payload.sessionSlug.trim() : '';
      if (pid !== null && session) bySession.set(session, pid);
    }
  }
  return bySession;
}

/**
 * Build the reap plan over a flat list of `{ pool, lane, dir, lease }` candidates. Pure — the shell resolves
 * each lease's per-lease signals (via the injected `signalsFor`) and this maps {@link classifyReap} over them.
 * @param {Array<{pool:string, lane:number, dir:string, lease:object|null}>} candidates
 * @param {{nowMs:number, ttlMs?:number, signalsFor?:((c:object)=>{prState?:any, sessionGone?:any, pidAlive?:any})|null}} opts
 * @returns {{reap:Array, keep:Array}} `reap` = candidates to collect (each + `reason`); `keep` = the rest.
 */
export function reapPlan(candidates, { nowMs, ttlMs = DEFAULT_LEASE_TTL_MINUTES * 60_000, signalsFor = null } = {}) {
  const reap = [];
  const keep = [];
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.lease) continue; // no lease → nothing to reap
    const extra = typeof signalsFor === 'function' ? signalsFor(c) || {} : {};
    const verdict = classifyReap(c.lease, {
      nowMs,
      ttlMs,
      prState: extra.prState ?? null,
      sessionGone: extra.sessionGone ?? null,
      pidAlive: extra.pidAlive ?? null,
    });
    if (verdict.reap) reap.push({ ...c, reason: verdict.reason });
    else keep.push({ ...c, reason: verdict.reason });
  }
  return { reap, keep };
}

// ── IO SHELL (runs only as a CLI — owns POOL_ROOT walk / marker reads / gh / the release delegation) ──────────

const HERE = dirname(fileURLToPath(import.meta.url));
const LANE_POOL_CLI = join(HERE, '..', 'lane-pool.mjs');
const expandHome = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
const POOL_ROOT = expandHome(process.env.LANE_POOL_ROOT) || join(homedir(), 'workspace', '.lanes');

// #4370 fork 4 — every reaper log line carries an ISO timestamp (the 2026-09-28 lane-18 reap could only be
// placed in time by line number).
const log = (m) => process.stderr.write(timestampLines(`${m}\n`));

/** Read + parse a lane's `.lane-lease` marker → the lease object, or null (missing / corrupt reads as none). */
function readLease(dir) {
  const file = join(dir, '.git', LEASE_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Lane indices under a pool dir (`lane-N` children), sorted — mirrors lane-pool's own `laneIndicesIn`. */
export function laneIndicesIn(poolDir) {
  if (!existsSync(poolDir)) return [];
  // A plain FILE beside the pools (macOS's `.metadata_never_index` Spotlight marker, a stray `.DS_Store`) is
  // not a pool: `readdirSync` on it throws ENOTDIR, and that one throw used to fail the WHOLE tick, every
  // tick — no gate ran host-wide for hours (2026-10-04 incident). A non-directory holds no lanes; skip it.
  let names;
  try { names = readdirSync(poolDir); } catch (e) { if (e?.code === 'ENOTDIR') return []; throw e; }
  return names
    .filter((d) => /^lane-\d+$/.test(d))
    .map((d) => Number(d.slice(5)))
    .sort((a, b) => a - b);
}

/** Pool names under POOL_ROOT that hold lanes (skip scratch clones / render siblings) — one or the selected. */
function poolsToScan(flags) {
  if (typeof flags.pool === 'string' && flags.pool) return [flags.pool];
  if (!existsSync(POOL_ROOT)) return [];
  return readdirSync(POOL_ROOT)
    .filter((name) => laneIndicesIn(join(POOL_ROOT, name)).length > 0)
    .sort();
}

/**
 * Whether the owning agent's process is alive. DORMANT under today's schema: the lease's `pid` is the
 * short-lived `lane-pool acquire` CLI (it exits right after stamping the marker — see lane-lease.mjs's "pid is
 * informational only"), NOT the delivery agent (an LLM has no unix pid). A literal check on it is meaningless —
 * it is ~always dead, and reaping on it would collect LIVE leases (the #2267 data-loss hazard). So this returns
 * `null` (unknown) for the current schema, and dead-agent reclamation rides the TTL-stale backstop instead. A
 * future lease that records a trustworthy long-lived `agentPid` (same host) plugs in here and the pure
 * classifier's `pid-dead` branch lights up unchanged.
 */
export function pidAliveForLease(lease) {
  const agentPid = lease && Number.isInteger(lease.agentPid) ? lease.agentPid : null;
  if (agentPid == null) return null; // no durable agent pid → axis dormant
  if (lease.host && lease.host !== hostname()) return null; // can't check a pid on another host
  try {
    process.kill(agentPid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'ESRCH' ? false : null; // ESRCH = gone; EPERM/other = can't tell → unknown
  }
}

/**
 * ONE `gh pr list` PER DISTINCT REPO among this pass's held leases → THAT repo's own PAIR of PR-state Maps: an
 * item-num-keyed one (`byItem`, matching each PR's head ref `lane/<num>-*` — for `conveyor-`/`prepare-`/
 * `prepare-decision-<item>` leases) and a PR-number-keyed one (`byPr` — for `review-`/`fix-`/`ci-heal-`/
 * `inspect-<PR>` leases, #x5wm9ot). Terminal states win over `open` so a couple's merged WE PR reads `merged`.
 *
 * #xr4ygg7 (multi-repo slice 9) — REPLACES the old single, ALWAYS-WE read (`fetchPrStates`, no `repoKey`
 * parameter at all): now that {@link prNumFromSession} resolves a `fix-<tag>-<id>` session's PR num for ANY
 * constellation repo (see its own docblock), a plateau-app item "49" and a WE item "49" are BOTH real, DISTINCT
 * lookup keys — reading them out of ONE shared Map would let an unrelated WE PR #49 merging read as "plateau-
 * app's own item 49 is done", reclaiming a lane whose real work is still in flight (the reap axis this file
 * exists to gate SAFELY, per its own header). Scoping the `gh pr list` to `repoKey`'s own slug is what keeps a
 * WE lookup and a plateau-app lookup from ever sharing a Map.
 *
 * #x5wm9ot — split into `{byItem, byPr}` (was a bare `Map`): a `fix-<PR>` (or `review-`/`ci-heal-`/`inspect-`)
 * session's PR-state check must key off the PR's OWN number, never off `byItem`'s head-ref-derived item number
 * — see {@link prStatesByPrNumber}'s own docblock for the exact mixup this replaces. Both Maps are reduced from
 * the SAME one `gh pr list` call — no second fetch.
 *
 * @param {string} repoKey - which constellation repo's PR list to read (`'we'`/`'frontierui'`/`'plateau-app'`).
 * @param {object} flags - the CLI flags; `--no-check-prs` disables the axis globally, `--pr-repo=<owner/name>`
 *   overrides the WE slug ONLY (its historical pin, e.g. a fork/mirror) — a sibling repo always reads its own
 *   real constellation slug, never the override.
 * @param {{exec?:Function}} [o] - `exec` is injectable (mirrors `reconcile-fix-dispatch.mjs#freeLaneNumbers`'s
 *   own convention) so a unit test can assert the exact call without touching real `gh`. Defaults to
 *   {@link ghRestGetPaged}'s own default (`execFileSyncThrottled`, #4415) — never a bare, unattributed
 *   `execFileSync` — so this axis's spend is both attributed (caller+op) AND on the `core` REST bucket, not the
 *   shared `graphql` one.
 * @returns {{byItem:Map<string,string>, byPr:Map<string,string>}|null} null = axis off for this repo this run
 *   (gh failed, `--no-check-prs`, or `repoKey` has no known slug).
 */
export function fetchPrStatesForRepo(repoKey, flags, { exec } = {}) {
  if (flags['no-check-prs']) return null;
  const slug = repoKey === 'we' && typeof flags['pr-repo'] === 'string' ? flags['pr-repo'] : CONSTELLATION_REPOS[repoKey]?.slug;
  if (!slug) return null; // an unrecognized repo key has no gh slug to scope the read to — axis off for it
  // #4415 — was `gh pr list --state all --json …,mergeCommit` (a bare, unattributed, GraphQL-backed
  // `execFileSync`). Now the shared REST + ETag-conditional path (#4351): `restPullToPrStateShape` below
  // reshapes REST's `head.ref`/`merged_at`/`merge_commit_sha` into the exact fields
  // `prStatesFromList`/`prStatesByPrNumber`/`prDetailsFromList` already read.
  let prs;
  try {
    const pulls = ghRestGetPaged(`repos/${slug}/pulls?state=all`, {
      ...(exec ? { exec } : {}),
      context: slug,
      op: 'rest pr-list (lease-reaper)',
      maxItems: Number(flags['pr-limit']) || 400,
      execOpts: { timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' },
    });
    prs = pulls.map(restPullToPrStateShape);
  } catch (e) {
    log(`  ⚠ gh pr list (${slug}) failed — PR-terminal reap axis OFF for ${repoKey} this run (TTL-stale still applies): ${String(e?.message || e).split('\n')[0]}`);
    return null;
  }
  // pure "open wins" reductions — one fetch, THREE keyspaces: the pre-existing state-only pair (byItem/byPr,
  // unchanged shape, every existing caller/test untouched) plus the #xkk4lv7 detail-carrying `detailsByItem`
  // `resolveLeaseItemNum`'s branch fallback needs. NO `detailsByPr` twin: Fork 1 (this file's own header)
  // guarantees the branch fallback never even runs for a PR_KIND session (`prNumFromSession` resolving
  // non-null short-circuits it first), so a PR-number-keyed detail Map would have no consumer — round-4
  // convergence (simplicity finding) caught this as dead surface before it shipped.
  return {
    byItem: prStatesFromList(prs),
    byPr: prStatesByPrNumber(prs),
    detailsByItem: prDetailsFromList(prs),
  };
}

/**
 * ONE `claude agents --json --all` read → `{ states, pidAlive }` — the session-name→state Map
 * {@link sessionGoneForLease} checks leases against, PLUS (#3383) the session-name→real-liveness Map from the
 * SAME listing, so the phantom-listing widening above needs no second `claude` call. The real fix for the
 * 2026-09-04/05 dead-session-stays-leased incident (see this file's header and {@link sessionGoneForLease}'s own
 * doc). `--all` IS LOAD-BEARING, exactly as `session-reaper.mjs` documents for its own identical read: the plain
 * (no-`--all`) listing drops a session the instant it stops running, which is precisely the
 * `done`/`failed`/`stopped` shape this axis needs to see, not the shape it needs hidden.
 * Best-effort: any failure (no `claude` on PATH, a hung/timed-out CLI, unparsable output) disables BOTH axes for
 * this run (`states: null` → every lease's `sessionGone` is unknown → TTL-stale still bites), matching
 * {@link fetchPrStatesForRepo}'s own degrade-on-failure convention. `states` routes through {@link sessionStatesForReap},
 * NOT {@link sessionStateByName} directly, so a listing that PARSED but yielded zero background rows (a review
 * finding on #1921 — indistinguishable from a bad read) degrades that axis off too, not just a hard throw. The
 * ONE `ps aux` scan behind `pidAlive` ({@link scanPsOutput}, driver-watchdog.mjs's own probe) is skipped entirely
 * when nothing was listed — no rows, nothing to probe — mirroring that file's own discipline.
 *
 * #xbk2is9 — ALSO returns the RAW listing (`agents`) unfiltered by `kind`, for {@link ownerSessionAliveForLease}:
 * unlike `states`/`pidAlive` (background rows only — a hand-briefed lease's own owning row is `kind:
 * 'interactive'` and would be invisible through either), the owner-alive check needs the whole listing. `agents`
 * is `null` when the `claude` call itself failed, `--no-check-sessions` was set, or the call succeeded but its
 * output did not parse to an array — never a guess from a listing that never arrived, in whole or in shape. It
 * does NOT share `states`'s zero-background-rows degrade: a listing with interactive rows
 * but no background ones is a perfectly real read for `agents`' own purpose (there may be no background session
 * to find, while a hand-briefed lease's owning interactive row is still right there) — only `states`/`pidAlive`
 * (whose #1921 concern is specifically about the background-only population) degrade on that shape.
 */
export function fetchSessionSignals(flags, { exec = execFileSync } = {}) {
  if (flags['no-check-sessions']) return { states: null, pidAlive: new Map(), agents: null };
  let sessions;
  try {
    sessions = defaultListAgents({ exec, all: true });
  } catch (e) {
    log(`  ⚠ \`claude agents --json --all\` failed — session-gone reap axis OFF this run (TTL-stale still applies): ${String(e?.message || e).split('\n')[0]}`);
    return { states: null, pidAlive: new Map(), agents: null };
  }
  const states = sessionStatesForReap(sessions);
  if (!states) log('  ⚠ `claude agents --json --all` listed zero background session(s) — session-gone reap axis OFF this run (indistinguishable from a bad read; TTL-stale still applies)');
  // #3383 — ONE `ps aux` scan for the whole batch (never one subprocess per row), only when something was
  // listed at all; `scanPsOutput` itself never throws (best-effort, returns null on failure).
  const psOutput = Array.isArray(sessions) && sessions.length ? scanPsOutput({ exec }) : null;
  const pidAlive = sessionPidAliveByName(sessions, { psOutput });
  return { states, pidAlive, agents: Array.isArray(sessions) ? sessions : null };
}

/** #3903 — the io half of {@link detachedWrapperPidsBySession}: read every run record once, never throwing. */
function readDetachedWrapperPids(store = createFileRunStore()) {
  const runs = [];
  let ids = [];
  try { ids = store.list(); } catch { return new Map(); }
  for (const id of Array.isArray(ids) ? ids : []) {
    try { const run = store.read(id); if (run) runs.push(run); } catch { /* one bad record never blocks the sweep */ }
  }
  return detachedWrapperPidsBySession(runs);
}

/** #4370 — the actor name the reaper stamps on the journal line its `release` child writes. */
export const LEASE_REAPER_ACTOR = 'lease-reaper';

/**
 * #4332 — the per-lease reap-signal builder `main()` drives (extracted so tests exercise the real wiring).
 * `ownerAlive` is computed BEFORE item resolution so it can veto the branch-derived PR-terminal fallback.
 */
export function buildLeaseSignalsFor({ prStatesByRepo, sessionStates, sessionPidAlive, sessionAgents, wrapperPids, nowMs }) {
  return (c) => {
    // #x5wm9ot — an item-kind session (`conveyor-`/`prepare-`/`prepare-decision-`) checks `byItem` by its item
    // number; a PR_KIND session (`review-`/`fix-`/`ci-heal-`/`inspect-`) checks `byPr` by its OWN PR number —
    // never the other Map with the other kind's number (the exact bug this split fixes; see `matchSessionSlug`
    // and `fetchPrStatesForRepo`'s own docblocks).
    // #xkk4lv7 — `resolveLeaseItemNum` widens this to a THIRD population: a lease whose `session` matches
    // NEITHER namespace (a bare `acquire --purpose=` with no dispatcher-recognizable `--session=`) falls
    // through to the lane's own checked-out branch, corroborated per Fork 2/Option C — see its own docblock.
    const repoStates = c.repoKey ? prStatesByRepo.get(c.repoKey) : null;
    // #xbk2is9 — the lease's declared occupant (`workerSession`), read off the SAME listing
    // `sessionStates`/`sessionPidAlive` were reduced from — see `ownerSessionAliveForLease`'s own doc.
    const ownerAlive = ownerSessionAliveForLease(c.lease, sessionAgents, c.dir);
    const { itemNum, prNum } = resolveLeaseItemNum(c.lease, c.dir, { repoStates, nowMs, ownerAlive });
    const prState = repoStates
      ? (itemNum != null ? repoStates.byItem.get(itemNum) : prNum != null ? repoStates.byPr.get(prNum) : null) ?? null
      : null;
    // #3383 — the lease's own session's REAL process-liveness read (`null` when unknown/unlisted), threaded
    // into sessionGoneForLease's phantom-listing widening. Distinct from `pidAliveForLease` below, which
    // remains the dormant future-`agentPid` axis (today's leases carry no durable per-agent pid at all).
    const sessionPidAliveNow = c.lease?.session && sessionPidAlive.has(c.lease.session) ? sessionPidAlive.get(c.lease.session) : null;
    // #3903 — a detached delivery wrapper's own pid (see `detachedWrapperPidsBySession`).
    const wrapperPid = c.lease?.session ? wrapperPids.get(c.lease.session) : undefined;
    const wrapperAlive = wrapperPid === undefined ? null : Boolean(defaultIsPidAlive(wrapperPid));
    return {
      prState,
      sessionGone: sessionGoneForLease(c.lease, sessionStates, { nowMs, pidAlive: sessionPidAliveNow, wrapperAlive, ownerAlive }),
      pidAlive: pidAliveForLease(c.lease),
    };
  };
}

/**
 * Delegate the actual reclamation to lane-pool's release (reserved-lane protection lives there). #4370 — the
 * child's journal line names the reaper (not a bare host:pid) and carries the reap classification as its
 * reason (`session-gone`, `pr-merged`, `ttl-stale`, …).
 */
export function releaseLane(pool, lane, { reason = null, exec = execFileSync, cli = LANE_POOL_CLI, env = process.env } = {}) {
  // #x5n4zn3 — was bare (no timeout): a real `lane-pool.mjs release` call, one per reaped lease.
  const argv = [cli, 'release', `--pool=${pool}`, `--lane=${lane}`, '--force'];
  if (reason) argv.push(`--reason=${reason}`);
  exec('node', argv, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: resolveChildTimeoutMs(),
    killSignal: 'SIGKILL',
    env: { ...env, [LANE_JOURNAL_ACTOR_ENV]: LEASE_REAPER_ACTOR },
  });
}

function parseFlags(argv) {
  const flags = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = true;
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return flags;
}

function main(argv) {
  const flags = parseFlags(argv);
  const dryRun = !!flags['dry-run'];
  const ttlMinutes =
    flags['ttl-minutes'] !== undefined && Number.isFinite(Number(flags['ttl-minutes']))
      ? Number(flags['ttl-minutes'])
      : DEFAULT_LEASE_TTL_MINUTES;
  const ttlMs = ttlMinutes * 60_000;
  const nowMs = Date.now();

  const { states: sessionStates, pidAlive: sessionPidAlive, agents: sessionAgents } = fetchSessionSignals(flags); // states null on zero background rows too; agents null only on a failed/no-array read (see fetchSessionSignals's own doc)
  // #3903 — ONE read of the run store for every in-flight detached-wrapper pid. Best-effort: an unreadable
  // store or record leaves the map empty/partial, which only means the old (listing-only) behaviour applies.
  const wrapperPids = readDetachedWrapperPids();

  // Collect every held lease across the scanned pools into flat candidates, tagging each with the repo key ITS
  // POOL names (#xr4ygg7 — ground truth; see repoKeyForPool's own docblock for why this, never the session, is
  // what a PR-state lookup is scoped by).
  const candidates = [];
  for (const pool of poolsToScan(flags)) {
    const poolDir = join(POOL_ROOT, pool);
    const repoKey = repoKeyForPool(pool);
    for (const lane of laneIndicesIn(poolDir)) {
      const dir = join(poolDir, `lane-${lane}`);
      const lease = readLease(dir);
      if (lease) candidates.push({ pool, lane, dir, lease, repoKey });
    }
  }

  // #xr4ygg7 — ONE `gh pr list` per DISTINCT repo actually present among this pass's held leases (never one
  // always-WE read): fetched only for repos this pass will actually need, and cached so two candidates sharing
  // a pool never re-fetch. A pool this constellation table doesn't recognize (repoKey === null) never reaches
  // `fetchPrStatesForRepo` at all — its candidates simply carry no PR-terminal signal (TTL-stale still bites).
  const distinctRepoKeys = [...new Set(candidates.map((c) => c.repoKey).filter(Boolean))];
  const prStatesByRepo = new Map(distinctRepoKeys.map((repoKey) => [repoKey, fetchPrStatesForRepo(repoKey, flags)]));

  const signalsFor = buildLeaseSignalsFor({ prStatesByRepo, sessionStates, sessionPidAlive, sessionAgents, wrapperPids, nowMs });
  const { reap, keep } = reapPlan(candidates, { nowMs, ttlMs, signalsFor });

  // Reclaim (unless dry-run). A single failed release is logged and skipped — the reaper is best-effort and one
  // stuck lane must not abort the whole sweep — but a failure count surfaces via a non-zero exit (below) so a
  // cron/loop wrapper can tell a clean sweep from a partial one.
  let reaped = 0;
  let failures = 0;
  const done = [];
  for (const c of reap) {
    if (dryRun) {
      log(`  would reap ${c.pool}/lane-${c.lane} (${c.reason}; session ${c.lease?.session ?? 'unknown'})`);
      continue;
    }
    try {
      releaseLane(c.pool, c.lane, { reason: c.reason });
      log(`  reaped ${c.pool}/lane-${c.lane} (${c.reason}; was session ${c.lease?.session ?? 'unknown'})`);
      done.push({ pool: c.pool, lane: c.lane, reason: c.reason, session: c.lease?.session ?? null });
      reaped++;
    } catch (e) {
      log(`  ⚠ ${c.pool}/lane-${c.lane}: release failed (${String(e?.message || e).split('\n')[0]}) — left in place`);
      failures++;
    }
  }

  // #xr4ygg7 — the PR-terminal axis is now PER REPO (see fetchPrStatesForRepo): reported as an object, not one
  // shared flag, so a WE-only `gh` outage never reads as "plateau-app's axis was down too" or vice-versa.
  const prAxisByRepo = Object.fromEntries(distinctRepoKeys.map((k) => [k, prStatesByRepo.get(k) ? 'on' : 'off']));
  if (flags.json) {
    process.stdout.write(
      JSON.stringify(
        {
          scanned: candidates.length,
          reaped: dryRun ? 0 : reaped,
          failures: dryRun ? 0 : failures,
          wouldReap: dryRun ? reap.map((c) => ({ pool: c.pool, lane: c.lane, reason: c.reason, session: c.lease?.session ?? null })) : undefined,
          collected: dryRun ? undefined : done,
          kept: keep.length,
          prAxis: prAxisByRepo,
          sessionAxis: sessionStates ? 'on' : 'off',
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    const prAxisSummary = distinctRepoKeys.length
      ? distinctRepoKeys.map((k) => `${k}:${prAxisByRepo[k]}`).join(',')
      : 'off';
    log(
      `lease-reaper: ${candidates.length} held lease(s) · ` +
        `${dryRun ? `${reap.length} would reap` : `${reaped} reaped${failures ? `, ${failures} failed` : ''}`} · ${keep.length} kept · ` +
        `PR-axis [${prAxisSummary}] · session-axis ${sessionStates ? 'on' : 'off'}`,
    );
  }
  // Non-zero exit only when a release we attempted actually FAILED (a gh-axis-off run is a clean degrade, not a
  // failure) — so a cron/loop wrapper can distinguish a clean sweep from a partial one.
  process.exit(failures > 0 ? 1 : 0);
}

// Run the IO shell only when invoked directly — never on import (keeps the pure core side-effect-free).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2));
}
