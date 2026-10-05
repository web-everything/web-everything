#!/usr/bin/env node
/**
 * @file scripts/lane-whois.mjs
 * @description LANE WHOIS (#3383, epic #3383). The operator's ask: "we need to be able to trace every lane
 * back to the session/card/PR that used it, and know its status." Today that's only inferable by hand from
 * commit messages and changed files, or by grepping Claude transcripts one lane at a time. This is the
 * declared operation that does it for every lane in a pool, read-only, in one pass:
 *
 *   node scripts/lane-whois.mjs [--lane=N] [--json] [--repo=<checkout>] [--branch=<ref>] [--pool-root=<path>]
 *   node scripts/lane-whois.mjs --history <N> [--json] [--pool-root=<path>]   # #4370 lane N's lifecycle journal
 *
 * READ-ONLY, ALWAYS: every git/gh call this file makes is a read (`status`, `log`, `rev-list`, `cherry`,
 * `show`, `branch -r --contains`, `gh pr list`) or a listing (`claude agents --json`). It never resets,
 * commits, pushes, or releases a lease - "whois" only REPORTS; `lane-pool.mjs release`/`reap` remain the only
 * things that ever touch a lease marker, and nothing here calls them. A dry-run reclaim PLAN is exactly that:
 * a `reclaimable: true/false` field on the report, never an action.
 *
 * PER LANE, THIS ANSWERS:
 *   - the current lease (if any) and whether its holder is presumed alive (TTL) or actually LIVE (`claude
 *     agents --json` lists a background session at this lane's cwd, or matching the lease's `ownerSession`) -
 *     see `holderAlive`/`liveOwner` below (#3383 "ASK THE LIVE OWNER": this only SURFACES that fact, it never
 *     sends the owning session anything - no auto-messaging is built here);
 *   - the last holder, from the lane-history ledger (`lib/lane-history.mjs`) when one exists, else the best
 *     available INFERENCE: the HEAD commit subject, card ids guessed from changed/untracked paths + branch,
 *     and - the strongest inference signal - EXACT transcript attribution (`lib/lane-transcript-attribution.mjs`):
 *     which Claude session(s) actually wrote the files sitting uncommitted in this lane, with timestamps;
 *   - an uncommitted/ahead summary, and for every ahead commit whether it is provably on a remote branch or
 *     patch-equivalent already in `origin/<branch>`;
 *   - `headSha` / `branch` / `branchTipSha` (#4344): this lane's own HEAD sha and branch, and the pool
 *     branch's tip sha as this lane's own clone currently knows it — lets a caller (`lane-pool-health-watch.mjs`)
 *     tell "already sitting at the tip" apart from "clean, but still behind it" with no git of its own;
 *   - for every guessed card: its `status` on `origin/<branch>`'s backlog;
 *   - for every PR found for those cards (`gh pr list --search <card>`, throttled via `lib/gh-throttle.mjs`):
 *     its state;
 *   - a verdict: `in-use | finished-reclaimable | finished-needs-review | unknown-work`
 *     ({@link classifyLaneVerdict} in `lib/lane-whois-core.mjs` - see that file for the exact rule).
 *
 * PURE/IO SPLIT: the verdict rule itself lives in `lib/lane-whois-core.mjs` (unit-tested with no fs/git at
 * all). This file is the IO shell that gathers the facts a real lane's git state, ledger, transcripts, and
 * `gh` provide, then hands them to that pure core.
 */
import { cachedClaudeAgents } from './lib/claude-agents-cache.mjs';
import { execFileSync } from 'node:child_process';
import {
  existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import { guardedPoolRoot } from './lib/lane-pool-paths.mjs';
import { LEASE_FILENAME, isLeaseStale, describeLease, laneHolderSlug, DEFAULT_LEASE_TTL_MINUTES } from './lib/lane-lease.mjs';
import { readLaneHistory, lastLaneHistoryEntry, readLaneJournal } from './lib/lane-history.mjs';
import { claudeProjectsRoot, scanLaneTranscripts, summarizeLaneTouches } from './lib/lane-transcript-attribution.mjs';
import { liveAgentInLane, agentsInLane, leaseSessionIds } from './lib/lane-salvage.mjs';

// #4544 — the `claude agents --json` vocabulary for "actually running", observed on a live host: background
// sessions carry `state: "working"`; interactive ones carry `status: "busy"` (an idle one is `status: "idle"`,
// with no `state`). Anything else — absent, idle, unknown — is merely LISTED, not a worker.
const RUNNING_STATES = new Set(['working']);
const RUNNING_STATUSES = new Set(['busy']);
/** A running entry that exposes a last-activity time is stale (hung) once it is older than this. */
export const WORKER_ACTIVE_WINDOW_MS = 10 * 60_000;

/** PURE: is this listed agent entry actually running (explicit running state, and recently active when it says when)? */
export function isRunningAgent(a, nowMs = Date.now(), windowMs = WORKER_ACTIVE_WINDOW_MS) {
  if (!a || !(RUNNING_STATES.has(a.state) || RUNNING_STATUSES.has(a.status))) return false;
  const at = [a.lastActivityAt, a.updatedAt].find((t) => Number.isFinite(t));
  return at === undefined || nowMs - at <= windowMs;
}
import {
  guessCardIds, classifyLaneVerdict, holderPresumedAlive, prsMatchingCard, keepMarkerApplies, formatLaneTimeline,
} from './lib/lane-whois-core.mjs';
import { readField } from './backlog/frontmatter.mjs';
import { execFileSyncThrottled } from './lib/gh-throttle.mjs';
import { ghRestGetPaged } from './lib/gh-rest-read.mjs';

const LEASE_MARKER = (dir) => join(dir, '.git', LEASE_FILENAME);

// ── SPEED (#3383 follow-up — see we:backlog for the "bound the whole-pool scan" story). Every subprocess this
// file spawns is now hard-timed: an UNBOUNDED `execFileSync` here is exactly the hang class
// `we:scripts/lib/bounded-child.mjs`'s own header names ("a single stuck lane must not stall the whole sweep") —
// this file used to have NONE. Env-overridable so a slow/loaded host can raise them without a code change.
const GIT_TIMEOUT_MS = Number(process.env.WE_LANE_WHOIS_GIT_TIMEOUT_MS) || 15_000;
const GH_TIMEOUT_MS = Number(process.env.WE_LANE_WHOIS_GH_TIMEOUT_MS) || 30_000;
/** Cap on `git branch -r --contains <sha>` probes PER LANE (each scans every ref) — a lane hundreds of commits
 *  ahead used to run one of these per commit; now it stops once its own budget is spent and the remaining
 *  commits are reported conservatively unpreserved (never wrongly reclaimed — same "fails closed" contract the
 *  rest of this file already documents). */
const MAX_CONTAINS_PROBES = Number(process.env.WE_LANE_WHOIS_MAX_CONTAINS_PROBES) || 15;
/** Cap on OTHER remote refs tried per lane's cross-branch preservation fallback (was 100 — the real cost driver
 *  measured live: a lane with several genuinely-orphaned dirty files times up to 100 `git show` spawns EACH). */
const MAX_OTHER_REFS = Number(process.env.WE_LANE_WHOIS_MAX_REFS) || 20;
/** Hard ceiling on TOTAL `git show <ref>:<path>` fallback spawns for one lane, summed across every dirty file —
 *  bounds the worst case (many dirty files, none matching origin directly) to a fixed cost regardless of how
 *  many files or refs exist. Once spent, remaining files are reported unpreserved without further spawns
 *  (conservative — a lane is simply left un-reclaimed, never wrongly reclaimed). */
const MAX_FALLBACK_SHOWS = Number(process.env.WE_LANE_WHOIS_MAX_FALLBACK_SHOWS) || 40;
/** How many PRs one batched `gh pr list --state all` call fetches (see {@link fetchAllPrs}'s own docblock for
 *  why this replaces one `gh pr list --search <id>` call PER card id). */
const PR_LIST_LIMIT = Number(process.env.WE_LANE_WHOIS_PR_LIST_LIMIT) || 500;
/** How long a cached `gh pr list` fetch stays fresh before a run re-fetches — amortizes the one network call
 *  across the health-watch daemon's own repeat ticks (#3383 gap 2), not just within one process's lifetime. */
const PR_CACHE_TTL_MS = Number(process.env.WE_LANE_WHOIS_PR_CACHE_TTL_MS) || 60_000;

/** Read-only `git`. Never throws - a probe failure just means "unknown", never a crash. Hard-timed (see above)
 *  so one wedged lane (corrupt object DB, an fsmonitor hook that hangs, an NFS-mounted clone gone stale) can
 *  never stall the whole pool sweep — the same failure shape a `null` return already handles everywhere else
 *  in this file. */
function tryGit(dir, args, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
    }).replace(/\n+$/, '');
  } catch {
    return null;
  }
}

function readLease(dir) {
  try {
    const parsed = JSON.parse(readFileSync(LEASE_MARKER(dir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// #4139 — the KEEP marker `we:scripts/lane-pool.mjs keep --lane=N` writes (same `.git/`-internal home as
// `LEASE_MARKER`, for the same reasons: never tracked, never `git clean`-ed, invisible to `git status`).
// Read-only here, matching this whole file's read-only contract — only `lane-pool.mjs` ever writes it.
const KEEP_MARKER = (dir) => join(dir, '.git', '.lane-keep');

function readKeepMarker(dir) {
  try {
    const parsed = JSON.parse(readFileSync(KEEP_MARKER(dir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** `git status --porcelain=v1` -> `{ trackedModifiedPaths, untrackedPaths }`, both lane-relative. */
export function gitStatusSummary(dir) {
  const out = tryGit(dir, ['status', '--porcelain=v1']);
  const trackedModifiedPaths = [];
  const untrackedPaths = [];
  if (out) {
    for (const line of out.split('\n')) {
      if (!line) continue;
      const code = line.slice(0, 2);
      const path = line.slice(3).replace(/^"|"$/g, '');
      if (code === '??') untrackedPaths.push(path);
      else trackedModifiedPaths.push(path);
    }
  }
  return { trackedModifiedPaths, untrackedPaths };
}

/** Field separator for the batched sha+subject read below — a byte that can never appear in a commit subject
 *  (git itself uses `\x1f`/`%x1f` for exactly this in its own `--format` docs). */
const LOG_FIELD_SEP = '\x1f';

/**
 * Every local commit ahead of `origin/<branch>`, oldest first, with its subject. #3383-perf: ONE `git log` call
 * (sha+subject in a single `--format`), never `rev-list` (shas) followed by one `log -1` PER COMMIT — a lane
 * sitting on hundreds of unpushed commits (live-observed: 148 on one real lane) used to cost that many spawns
 * just to list subjects.
 */
export function aheadCommits(dir, branchRef) {
  const out = tryGit(dir, ['log', '--reverse', `--format=%H${LOG_FIELD_SEP}%s`, `${branchRef}..HEAD`]);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const i = line.indexOf(LOG_FIELD_SEP);
    return i === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });
}

/**
 * Preservation proof for ahead commits: patch-equivalent already in `origin/<branch>` (`git cherry`, '-' =
 * equivalent) OR the sha is contained in ANY remote-tracking branch (provably pushed somewhere, even if not
 * yet merged). Returns `Map<sha, boolean>`.
 *
 * #3383-perf: `git branch -r --contains <sha>` scans EVERY ref in the clone, so one lane with N un-equivalent
 * ahead commits used to cost N of them — unbounded, and the dominant cost on any lane with a lot of genuinely
 * orphaned/unpushed work (exactly the lanes this proof matters most for). Bounded to
 * {@link MAX_CONTAINS_PROBES} PER LANE: once spent, remaining commits are reported unpreserved without a
 * further spawn — conservative, never a false "preserved", and the verdict only ever needed to know
 * "is there at least one unpreserved commit", so this never trades away correctness, only extra confirming
 * spawns once the answer is already "no" for the caller's purposes.
 */
export function aheadCommitsPreserved(dir, branchRef, commits, maxProbes = MAX_CONTAINS_PROBES) {
  const result = new Map();
  if (!commits.length) return result;
  const cherry = tryGit(dir, ['cherry', branchRef, 'HEAD']) || '';
  const equivalent = new Set(
    cherry.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()),
  );
  let probes = 0;
  for (const { sha } of commits) {
    if (equivalent.has(sha)) { result.set(sha, true); continue; }
    if (probes >= maxProbes) { result.set(sha, false); continue; }
    probes += 1;
    const containing = tryGit(dir, ['branch', '-r', '--contains', sha]);
    result.set(sha, !!(containing && containing.trim()));
  }
  return result;
}

/**
 * Every OTHER remote-tracking ref in a lane's clone (never `branchRef` itself — the caller already checked
 * that one directly), bounded — a long-lived pool clone accumulates many stale `lane/*` remote refs, and this
 * is read ONCE PER LANE (not once per dirty file — see {@link filePreservedInMain}'s caller), so the bound
 * only matters for the fallback scan's own cost, never for how many times `for-each-ref` itself runs.
 */
export function otherRemoteRefs(dir, branchRef, max = MAX_OTHER_REFS) {
  const skip = `/${branchRef.split('/').pop()}`;
  return (tryGit(dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes']) || '')
    .split('\n').filter(Boolean).filter((ref) => !ref.endsWith(skip)).slice(0, max);
}

/**
 * Does `origin/<branch>` (or, failing that, ANY OTHER remote branch in `refs`) hold identical content at
 * `relPath`? `refs` is computed ONCE per lane by the caller ({@link otherRemoteRefs}) and reused across every
 * dirty file — this function itself never re-lists refs, so its cost is one `git show` per candidate, not one
 * `for-each-ref` PLUS N `git show` calls per file.
 */
export function filePreservedInMain(dir, relPath, branchRef, localContent, refs = []) {
  const upstream = tryGit(dir, ['show', `${branchRef}:${relPath}`]);
  if (upstream !== null && upstream === localContent) return true;
  for (const ref of refs) {
    const content = tryGit(dir, ['show', `${ref}:${relPath}`]);
    if (content !== null && content === localContent) return true;
  }
  return false;
}

/** A lane sitting on more dirty paths than this skips the cross-branch fallback entirely (see
 *  {@link lanePreservedFileChecker}). */
const HEAVY_DIRTY_THRESHOLD = 25;

/**
 * The ONE per-lane "is this dirty file provably preserved?" predicate — shared by `whoisForLane` below and
 * `lane-pool.mjs#laneReclaimPreservationProof` (PR #2641 review) so the two re-derivations can never drift on
 * bounding. Computes the other-refs list ONCE for the lane (skipped outright for a heavily-dirty lane — the
 * direct `origin/<branch>` check still runs) and spends a LANE-WIDE budget of `maxFallbackShows` fallback
 * `git show <ref>:<path>` spawns, summed across every file it is asked about. Once spent, remaining files skip
 * the fallback and are reported unproven — conservative (a lane is simply left un-reclaimed), never wrong.
 * @returns {(relPath: string) => boolean}
 */
export function lanePreservedFileChecker(dir, branchRef, dirtyPaths, { maxFallbackShows = MAX_FALLBACK_SHOWS } = {}) {
  const otherRefs = dirtyPaths.length && dirtyPaths.length <= HEAVY_DIRTY_THRESHOLD ? otherRemoteRefs(dir, branchRef) : [];
  let fallbackBudget = maxFallbackShows;
  return (relPath) => {
    let local;
    try { local = readFileSync(join(dir, relPath), 'utf8'); } catch { local = null; }
    if (local === null) return false;
    const refsToTry = otherRefs.slice(0, Math.max(0, fallbackBudget));
    fallbackBudget -= refsToTry.length;
    return filePreservedInMain(dir, relPath, branchRef, local, refsToTry);
  };
}

/** `claude agents --json` - the LIVE session listing (background agents, this host). Best-effort. */
export function liveAgentSessions({ exec = execFileSync } = {}) {
  try {
    const out = cachedClaudeAgents({ fetch: () => exec('claude', ['agents', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Is `sessionId` (or a session whose `cwd` is this lane) listed as a live, non-terminal agent? */
export function isSessionAlive(sessionId, laneDir, agents) {
  const DONE_STATES = new Set(['done', 'failed', 'stopped']);
  return agents.some((a) => (
    ((typeof sessionId === 'string' && sessionId.length > 0 && a.sessionId === sessionId) || (laneDir && a.cwd === laneDir)) && !DONE_STATES.has(a.state)
  ));
}

/** Every `backlog/<id>-*.md` path on `origin/<branch>`, keyed by id, for a set of guessed ids. Read-only. */
function backlogStatusesForCards(dir, branchRef, cardIds, listingCache) {
  if (!cardIds.length) return {};
  let listing = listingCache.get(branchRef);
  if (listing === undefined) {
    listing = (tryGit(dir, ['ls-tree', '-r', '--name-only', branchRef, '--', 'backlog/']) || '')
      .split('\n').filter(Boolean);
    listingCache.set(branchRef, listing);
  }
  const out = {};
  for (const id of cardIds) {
    const path = listing.find((p) => new RegExp(`^backlog/0*${id}-`, 'i').test(p));
    if (!path) { out[id] = null; continue; }
    const body = tryGit(dir, ['show', `${branchRef}:${path}`]);
    out[id] = body != null ? (readField(body, 'status') || null) : null;
  }
  return out;
}

/**
 * On-disk cache path for {@link fetchAllPrs}'s fetch — a sibling of the lease markers, under the pool dir
 * itself (never inside a lane, which `reclaim`/`trim` may reset or trash). Best-effort: this file existing,
 * being fresh, or being writable are all optional — a cache miss just means "fetch again", never a crash.
 */
function prListCachePath(poolDir) {
  return join(poolDir, '.whois-pr-cache.json');
}

/**
 * ONE `gh pr list --state all --json …` call for the WHOLE run (and, via an on-disk cache, amortized across
 * REPEAT runs too — #3383 gap 2's health-watch daemon calls this every tick). #3383-perf: this is the direct
 * replacement for the old `prStatesForCards`, which called `gh pr list --search <id>` once PER DISTINCT card
 * id — measured as the single largest wall-clock cost against the real ~68-lane WE pool (dozens of network
 * round-trips, each hundreds of ms, run serially). Matching a card id against the fetched list is now
 * {@link prsMatchingCard} (pure, in `lane-whois-core.mjs`) — no further `gh` calls at all.
 *
 * STATED LIMITATION: `--limit` bounds how many PRs come back (most-recent-first, GitHub's own default list
 * order) — a card whose only PR is older than that window won't be found via this axis (the CARD-STATUS axis,
 * read straight off `backlog/*.md` frontmatter, is unaffected and often still resolves the verdict on its own).
 * The old `--search`-per-id approach had its own, differently-shaped window (GitHub search's relevance ranking
 * and its own result cap) — this trades that for one bounded, one-shot call instead of N.
 */
export function fetchAllPrs({
  ghRepo, exec = execFileSync, poolDir = null, nowMs = Date.now(), cacheTtlMs = PR_CACHE_TTL_MS,
} = {}) {
  if (ghRepo && (typeof ghRepo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(ghRepo)
    || ghRepo.split('/').some(segment => segment === '.' || segment === '..'))) return [];
  const cachePath = poolDir ? prListCachePath(poolDir) : null;
  if (cachePath) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (cached && cached.ghRepo === (ghRepo || null) && Number.isFinite(cached.fetchedAtMs)
        && nowMs - cached.fetchedAtMs < cacheTtlMs && Array.isArray(cached.prs)) {
        return cached.prs;
      }
    } catch { /* absent/corrupt/stale — fetch fresh below */ }
  }
  let prs = [];
  try {
    // #4351 — REST, not `gh pr list --state all --limit 500` (GraphQL, ~5 points a call and this caller's
    // 754 calls/24h ranked it among the top GraphQL spenders). Same order (created, newest first), each page a
    // conditional GET, so an unchanged page is a free 304. `{owner}/{repo}` keeps gh's own cwd resolution
    // when no repo was named; the cwd then joins the ETag cache key.
    const repoPath = ghRepo ? `repos/${ghRepo}` : 'repos/{owner}/{repo}';
    // maxBuffer: 500 PRs' worth of `body` text easily clears Node's 1MB default and fails CLOSED with ENOBUFS
    // (caught below, degrading to "no PR evidence" — live-caught during this item's own before/after proof: a
    // silent 0-result fetch that made every card/PR-backed verdict look like `unknown-work` instead of its real
    // answer). 32MB matches this file's other large batched reads (`batchPatchIds`-shaped calls elsewhere).
    const pulls = ghRestGetPaged(`${repoPath}/pulls?state=all`, {
      maxItems: PR_LIST_LIMIT, context: ghRepo ? '' : process.cwd(), op: 'rest pulls (whois)',
      exec: (file, args, opts) => execFileSyncThrottled(file, args, {
        ...opts, timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
        throttle: { ...opts.throttle, ...(exec !== execFileSync ? { exec: (argv, options) => exec(file, argv, options) } : {}) },
      }),
    });
    prs = pulls.map(restPullToListShape);
  } catch {
    prs = []; // no `gh`, no network, no auth — degrade to "no PR evidence found", never crash the whole report
  }
  if (cachePath) {
    try {
      mkdirSync(poolDir, { recursive: true });
      fsWriteFileSync(cachePath, JSON.stringify({ ghRepo: ghRepo || null, fetchedAtMs: nowMs, prs }), 'utf8');
    } catch { /* best-effort — a cache write failure never fails the run */ }
  }
  return prs;
}

/**
 * #4351 — one REST `pulls` item in the exact shape `gh pr list --json number,state,title,headRefName,body`
 * returned: REST's `state` is only open/closed, so a set `merged_at` means `MERGED`; `head.ref` is
 * `headRefName`; a `null` body is `""` (gh's own rendering). PURE.
 */
export function restPullToListShape(p) {
  if (p == null) throw new TypeError('REST pull must not be null or undefined');
  const state = p.merged_at ? 'MERGED' : String(p.state || '').toUpperCase();
  return { number: p.number, state, title: p.title ?? '', headRefName: p.head?.ref ?? '', body: p.body ?? '' };
}

/** In-process match against the ONE fetched PR list (see {@link fetchAllPrs}) — cached per run so a card id
 *  guessed on more than one lane is matched once, not once per lane. */
function prStatesForCards(cardIds, prCache, allPrs) {
  const out = {};
  for (const id of cardIds) {
    if (prCache.has(id)) { out[id] = prCache.get(id); continue; }
    const states = prsMatchingCard(allPrs, id);
    prCache.set(id, states);
    out[id] = states;
  }
  return out;
}

/** Lane numbers actually present under a pool dir (`lane-N` subdirectories). */
export function listLaneNumbers(poolDir) {
  if (!existsSync(poolDir)) return [];
  return readdirSync(poolDir)
    .map((name) => /^lane-(\d+)$/.exec(name))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/**
 * Build the full whois report for ONE lane. `transcriptTouches` is this lane's slice of the ALREADY-computed
 * whole-tree scan (so N lanes cost exactly one grep pass, never N).
 */
export function whoisForLane({
  poolDir, laneNum, branchRef, ghRepo, transcriptTouches, agents, nowMs, ttlMs, listingCache, prCache, allPrs = [],
}) {
  const dir = join(poolDir, `lane-${laneNum}`);
  if (!existsSync(dir)) return { lane: laneNum, path: dir, exists: false };

  const lease = readLease(dir);
  const leaseTtlAlive = holderPresumedAlive(lease, isLeaseStale, nowMs, ttlMs);

  const history = readLaneHistory(dir);
  const last = lastLaneHistoryEntry(history);
  // A released holder is attribution only. Match current lease identities or an exact lane cwd.
  const liveOwner = liveAgentInLane(agents, dir, leaseSessionIds(lease));
  const holderAlive = leaseTtlAlive || liveOwner;
  // #4544 — STRICTER than `liveOwner` (alert polarity: a false positive is noise): the matched session must be
  // actually running, not merely listed. `liveOwner`/`holderAlive` stay fail-safe for the reclaim gates.
  const liveWorker = agentsInLane(agents, dir, leaseSessionIds(lease))
    .some((a) => isRunningAgent(a, nowMs));

  const { trackedModifiedPaths, untrackedPaths } = gitStatusSummary(dir);
  const dirtyPaths = [...trackedModifiedPaths, ...untrackedPaths];
  const branch = tryGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
  const headSubject = tryGit(dir, ['log', '-1', '--format=%s']) || '';
  const commits = aheadCommits(dir, branchRef);
  const commitPreserved = aheadCommitsPreserved(dir, branchRef, commits);

  // #4139 — is a `keep` decision (`we:scripts/lane-pool.mjs keep --lane=N`) still on record for this lane's
  // CURRENT content? Re-derived fresh every call — never trusts a cached verdict — via the SAME pure
  // fingerprint comparison `keep`'s own marker is built to feed ({@link keepMarkerApplies}). A stale marker
  // (content changed since it was recorded) reads as NOT kept, so the lane resurfaces on its own with no
  // active cleanup needed.
  const keepMarker = readKeepMarker(dir);
  const headSha = tryGit(dir, ['rev-parse', 'HEAD']) || null;
  const kept = keepMarkerApplies(keepMarker, {
    headSha, dirtyPaths: [...dirtyPaths].sort(), aheadShas: commits.map((c) => c.sha).sort(),
  });
  // #4344 — the pool branch's tip sha, AS THIS LANE'S OWN CLONE ALREADY KNOWS IT (no fresh fetch — the same
  // locally-known `branchRef` `aheadCommits` above was already read against). Lets a caller tell "clean at the
  // tip" apart from "clean but behind it" with exactly one more cheap plumbing read, never a new heavy git call
  // — see `isLaneAlreadyClean` in `lib/lane-whois-core.mjs` for the full reasoning (incl. why this is not a new
  // staleness risk).
  const branchTipSha = tryGit(dir, ['rev-parse', branchRef]) || null;

  // Transcript attribution — the strongest inference signal when the ledger has nothing (a lane worked on
  // before this card wired up history-recording). Ranked by which session's edited-file set matches this
  // lane's ACTUAL dirty paths, per #3383's own coordination note.
  const attribution = summarizeLaneTouches(transcriptTouches || [], dir, dirtyPaths);
  const bestAttribution = attribution[0] || null;
  const attributionLiveOwner = !!bestAttribution && liveOwner
    && agentsInLane(agents, dir, leaseSessionIds(lease)).some((a) => a.sessionId === bestAttribution.sessionId);

  const cardIds = guessCardIds({ paths: dirtyPaths, commitSubject: headSubject, branch: branch || '' });
  const cardStatusById = backlogStatusesForCards(dir, branchRef, cardIds, listingCache);
  const cardStatuses = Object.values(cardStatusById).filter((s) => s != null);

  const prStateById = prStatesForCards(cardIds, prCache, allPrs);
  const allPrStates = Object.values(prStateById).flat().map((p) => p.state);

  // #3383-perf: the heavy-dirty skip and the LANE-WIDE fallback-spawn budget (was unbounded files × refs, the
  // single biggest cost measured live) both live in `lanePreservedFileChecker` — shared verbatim with
  // `lane-pool.mjs reclaim`'s own re-check so the two can never drift on bounding.
  const provenFile = lanePreservedFileChecker(dir, branchRef, dirtyPaths);
  const unpreservedFiles = dirtyPaths.filter((p) => !provenFile(p));
  const unpreservedCommits = commits.filter((c) => !commitPreserved.get(c.sha));
  const preserved = unpreservedFiles.length === 0 && unpreservedCommits.length === 0;

  const { verdict, reason } = classifyLaneVerdict({
    holderAlive,
    uncommittedCount: dirtyPaths.length,
    aheadCount: commits.length,
    cardStatuses,
    prStates: allPrStates,
    preserved,
  });

  return {
    lane: laneNum,
    path: dir,
    exists: true,
    lease: lease ? { ...lease, describe: describeLease(lease), holder: laneHolderSlug(lease) } : null,
    holderAlive,
    liveOwner,
    liveWorker,
    lastHolder: last || (bestAttribution ? {
      source: 'transcript-attribution',
      sessionId: bestAttribution.sessionId,
      lastWriteTs: bestAttribution.lastWriteTs,
      matchedFiles: bestAttribution.matchedFiles,
      coverage: bestAttribution.coverage,
      liveOwner: attributionLiveOwner,
    } : null),
    inference: last ? null : { headSubject, branch, cardIds, transcriptAttribution: attribution },
    // #4344 — exposed at the top level (not just buried in `inference`, which is `null` once a ledger entry
    // exists) so a caller can tell "already at the pool branch tip" apart from "clean but behind it" without
    // any git of its own — see `isLaneAlreadyClean` in `lib/lane-whois-core.mjs`.
    branch,
    headSha,
    branchTipSha,
    uncommitted: { trackedModified: trackedModifiedPaths.length, untracked: untrackedPaths.length, trackedModifiedPaths, untrackedPaths },
    ahead: { count: commits.length, commits: commits.map((c) => ({ ...c, preserved: !!commitPreserved.get(c.sha) })) },
    cards: cardIds.map((id) => ({ id, status: cardStatusById[id] })),
    prs: cardIds.flatMap((id) => (prStateById[id] || []).map((pr) => ({ card: id, ...pr }))),
    preserved,
    unpreservedFiles,
    verdict,
    reason,
    // #4139 — `kept`: does an operator's `keep --lane=N` decision still apply to this lane's CURRENT content?
    // `keptInfo` carries the marker's own record (reason/keptAt/keptBy) when `kept` is true, purely for the
    // human-facing report — `laneReclaimQueue` (`we:scripts/operations/operator-queue.mjs`) filters on `kept`
    // alone.
    kept,
    keptInfo: kept ? { reason: keepMarker.reason ?? null, keptAt: keepMarker.keptAt ?? null, keptBy: keepMarker.keptBy ?? null } : null,
  };
}

/** The origin URL's repo basename (no `.git`) - used as `gh --repo` and to name the pool dir when unstated. */
function repoSlugFromOrigin(checkoutRoot) {
  const url = tryGit(checkoutRoot, ['remote', 'get-url', 'origin']);
  if (!url) return null;
  const m = /([^/:]+?)(\.git)?$/.exec(url.trim());
  return m ? m[1] : null;
}

/**
 * Resolve `{ poolRoot, poolDir, poolName, ghRepo, branch }` from CLI-shaped flags. `checkoutRoot` defaults to
 * the cwd's git toplevel; `poolRootOverride` (tests, or an explicit `--pool-root=`) bypasses `guardedPoolRoot`'s
 * real-pool-in-vitest guard entirely.
 */
export function resolvePool({ checkoutRoot = process.cwd(), poolRootOverride, poolName, branch = 'main' } = {}) {
  let root;
  try { root = tryGit(checkoutRoot, ['rev-parse', '--show-toplevel']) || checkoutRoot; } catch { root = checkoutRoot; }
  const poolRoot = poolRootOverride || guardedPoolRoot(root, process.env);
  const name = poolName || repoSlugFromOrigin(root) || basename(root);
  return {
    poolRoot,
    poolDir: join(poolRoot, name),
    poolName: name,
    ghRepo: null, // best-effort: gh infers the repo from cwd when unset; explicit --gh-repo overrides in main()
    branch,
  };
}

/**
 * The full read-only whois report over a pool. ONE transcript grep pass for every lane requested (never one
 * per lane), per #3383's own performance note.
 */
export function whois({
  poolDir, laneNumbers, branch = 'main', ghRepo = null, projectsRoot = claudeProjectsRoot(), nowMs = Date.now(),
  ttlMinutes = DEFAULT_LEASE_TTL_MINUTES, exec = execFileSync,
} = {}) {
  const lanes = laneNumbers && laneNumbers.length ? laneNumbers : listLaneNumbers(poolDir);
  const branchRef = branch.startsWith('origin/') ? branch : `origin/${branch}`;
  const lanePaths = Object.fromEntries(lanes.map((n) => [String(n), join(poolDir, `lane-${n}`)]));
  const touchesByLane = scanLaneTranscripts(projectsRoot, lanePaths, { exec });
  const agents = liveAgentSessions({ exec });
  const allPrs = fetchAllPrs({ ghRepo, exec, poolDir, nowMs });
  const listingCache = new Map();
  const prCache = new Map();
  const ttlMs = ttlMinutes * 60_000;
  const rows = lanes.map((n) => whoisForLane({
    poolDir, laneNum: n, branchRef, ghRepo,
    transcriptTouches: touchesByLane.get(String(n)) || [],
    agents, nowMs, ttlMs, listingCache, prCache, allPrs,
  }));
  return { poolDir, branch: branchRef, lanes: rows };
}

/**
 * Operator-queue integration point (#3383's own spec: "appears in a 'needs your decision' list surfaced in
 * `operations/operator-queue.mjs`"). Best-effort — every failure degrades to `[]`, never throws, so a caller
 * (operator-queue.mjs, via a subprocess spawn of THIS file's `--json` output) can fold it in without risking
 * its own PR-queue report.
 */
export function lanesNeedingDecision(report) {
  return (report.lanes || [])
    // #4139 — `!row.kept`: an operator's recorded `keep` call (still fresh — its fingerprint matches this
    // lane's CURRENT content) excludes the lane from this list until that content changes again.
    .filter((row) => row.exists && !row.kept && (row.verdict === 'finished-needs-review' || row.verdict === 'unknown-work'))
    .map((row) => ({
      lane: row.lane, path: row.path, verdict: row.verdict, reason: row.reason, preserved: row.preserved,
    }));
}

function printReport(report) {
  console.log(`lane-whois — pool ${report.poolDir} (compared against ${report.branch})`);
  for (const row of report.lanes) {
    if (!row.exists) { console.log(`lane-${row.lane}: (missing)`); continue; }
    console.log(`\nlane-${row.lane}  [${row.verdict}] — ${row.reason}`);
    console.log(`  lease: ${row.lease ? row.lease.describe : '(none)'}${row.holderAlive ? ' — holder ALIVE' : ''}${row.liveOwner ? ' (live session found)' : ''}${row.liveWorker ? ' (running)' : ''}`);
    if (row.lastHolder) {
      if (row.lastHolder.event) {
        console.log(`  last holder (ledger): ${row.lastHolder.event} @ ${row.lastHolder.ts} session=${row.lastHolder.session || row.lastHolder.ownerSession || '?'}${row.lastHolder.item ? ` item=${row.lastHolder.item}` : ''}${row.lastHolder.pr ? ` pr=${row.lastHolder.pr}` : ''}`);
      } else {
        console.log(`  last holder (transcript attribution): session=${row.lastHolder.sessionId} last-write=${row.lastHolder.lastWriteTs} coverage=${(row.lastHolder.coverage * 100).toFixed(0)}% files=${row.lastHolder.matchedFiles.join(', ') || '(none)'}${row.lastHolder.liveOwner ? ' — LIVE, ask before reclaiming' : ''}`);
      }
    }
    console.log(`  uncommitted: ${row.uncommitted.trackedModified} tracked, ${row.uncommitted.untracked} untracked; ahead: ${row.ahead.count}`);
    if (row.cards.length) console.log(`  cards: ${row.cards.map((c) => `${c.id}=${c.status || 'unknown'}`).join(', ')}`);
    if (row.prs.length) console.log(`  prs: ${row.prs.map((p) => `#${p.number}(${p.state}) for ${p.card}`).join(', ')}`);
    if (!row.preserved) console.log(`  NOT provably preserved: ${row.unpreservedFiles.join(', ') || '(some ahead commits)'}`);
    if (row.kept) {
      console.log(`  KEPT (#4139): ${row.keptInfo.reason || '(no reason recorded)'} — recorded ${row.keptInfo.keptAt || 'unknown time'}; excluded from LANE RECLAIM until this content changes`);
    }
  }
}

/**
 * #4370 — `lane-whois --history <lane>` (also `--history=<lane>`): print lane N's lifecycle journal timeline
 * (every lease write/delete, reset, clean, reclaim, litter deletion — with its actor and reason). Read-only; no
 * git, no `gh`, no agents scan. `--json` prints the raw entries.
 */
export function laneHistoryReport({ poolDir, lane }) {
  const n = Number(lane);
  if (!Number.isInteger(n) || n < 1) throw new Error('--history needs a lane number (e.g. `--history 18` or `--history=18`)');
  const entries = readLaneJournal(poolDir, { lane: n });
  return { poolDir, lane: n, entries, lines: formatLaneTimeline(entries, { lane: n }) };
}

export function main(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a) || /^--(.+)$/.exec(a);
    if (m) flags[m[1]] = m[2] === undefined ? true : m[2];
    else positional.push(a);
  }
  if (flags.history !== undefined) {
    const { poolDir } = resolvePool({
      checkoutRoot: flags.repo || process.cwd(), poolRootOverride: flags['pool-root'], poolName: flags.name,
    });
    const report = laneHistoryReport({ poolDir, lane: flags.history === true ? (flags.lane ?? positional[0]) : flags.history });
    if (flags.json) process.stdout.write(`${JSON.stringify({ poolDir: report.poolDir, lane: report.lane, entries: report.entries }, null, 2)}\n`);
    else console.log(report.lines.join('\n'));
    return;
  }
  const { poolDir, branch } = resolvePool({
    checkoutRoot: flags.repo || process.cwd(),
    poolRootOverride: flags['pool-root'],
    poolName: flags.name,
    branch: flags.branch || 'main',
  });
  const laneNumbers = flags.lane !== undefined ? [Number(flags.lane)] : null;
  const report = whois({ poolDir, laneNumbers, branch, ghRepo: flags['gh-repo'] || null });
  if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);
}

export function isCliEntry(argv1 = process.argv[1], moduleUrl = import.meta.url) {
  if (!argv1) return false;
  let resolved = argv1;
  try { resolved = realpathSync(argv1); } catch { /* not on disk */ }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isCliEntry()) main();
